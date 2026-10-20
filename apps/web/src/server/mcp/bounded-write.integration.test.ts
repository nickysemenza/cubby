import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { costTypeSchema, tradeSchema } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import { sql } from "drizzle-orm";
import {
  countTestDbQueries,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createMcpServer } from "~/server/mcp/server";
import type { ToolArguments } from "~/server/mcp/tools/tool-registration";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

// A constant statement count alone cannot detect one SQL statement scanning
// dependents. Forbid foreground dependent reads as well as per-dependent calls.
describe("bounded MCP writes", () => {
  const ctx = withTestDb("mcp");
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

  it.each(["commands", "bulkUpdate"] as const)(
    "bounds a 25-row %s batch independently of dependent count",
    async (mode) => {
      const kernel = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: testUserId(TEST_USER_ID) },
        }),
      );
      const samples = [];
      for (const dependents of [1, 1000]) {
        const subjects = [];
        for (let row = 0; row < 25; row++)
          subjects.push(
            await createProductFixture(
              ctx.db,
              makeProductInput({
                name: `Synthetic batch subject ${dependents} ${row}`,
              }),
              ctx.actor,
            ),
          );
        await getDb(ctx.db).execute(sql`
        WITH roots(id) AS (VALUES ${sql.join(
          subjects.map((subject) => sql`(${subject.entityId}::uuid)`),
          sql`, `,
        )})
        INSERT INTO "Expense" (shortcode,name,cost,date,"costType",trade,"productId","lineKind")
        SELECT 'EXP-SYN' || replace(roots.id::text,'-','') || n::text,
          'Synthetic batch dependent',1,'2026-01-01',${costTypeSchema.enum.materials},${tradeSchema.enum.other},roots.id,${expenseLineKindSchema.enum.principal}
        FROM roots CROSS JOIN generate_series(1,${dependents}) n`);
        const data = { notes: "Synthetic 25-row saved note" };
        const args: ToolArguments =
          mode === "commands"
            ? {
                action: mode,
                resultDetail: "full",
                commands: subjects.map((subject) => ({
                  action: "update",
                  entity: "product",
                  id: subject.id,
                  data,
                })),
              }
            : {
                action: mode,
                entity: "product",
                ids: subjects.map((subject) => subject.id),
                data,
                resultDetail: "full",
              };
        const measured = await countTestDbQueries(() =>
          callMcpTool(
            createMcpServer(),
            "entity",
            args,
            kernelRequestContext(kernel),
            { entityKernel: kernel },
          ),
        );
        expect(measured.result.isError).not.toBe(true);
        expect(measured.result.structuredContent).toMatchObject(
          mode === "commands"
            ? {
                results: subjects.map(() => ({ status: "succeeded" })),
              }
            : { action: "bulkUpdate", entity: "product" },
        );
        expect(
          measured.tables.filter((table) =>
            ["Expense", "SearchDocument"].includes(table),
          ),
        ).toEqual([]);
        expect(measured.queryCount).toBeLessThanOrEqual(25 * 90);
        expect(
          JSON.stringify(measured.result.structuredContent).length,
        ).toBeLessThan(40_000);
        samples.push(measured.queryCount);
      }
      expect(samples[1]).toBe(samples[0]);
    },
  );

  it.each(["update", "commands", "bulkUpdate"] as const)(
    "keeps %s independent of 1 versus 1000 dependent Expenses",
    async (mode) => {
      const kernel = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: testUserId(TEST_USER_ID) },
        }),
      );
      const samples = [];
      for (const dependents of [1, 1000]) {
        const subject = await createProductFixture(
          ctx.db,
          makeProductInput({ name: `Synthetic bounded ${mode} ${dependents}` }),
          ctx.actor,
        );
        await getDb(ctx.db).execute(sql`
        INSERT INTO "Expense" (shortcode,name,cost,date,"costType",trade,"productId","lineKind")
        SELECT 'EXP-SYN' || ${subject.entityId.slice(0, 8)} || n::text,
          'Synthetic dependent expense',1,'2026-01-01',${costTypeSchema.enum.materials},${tradeSchema.enum.other},${subject.entityId}::uuid,${expenseLineKindSchema.enum.principal}
        FROM generate_series(1,${dependents}) n`);
        const data =
          mode === "bulkUpdate"
            ? { notes: "Synthetic bounded bulk note" }
            : { name: `Synthetic saved ${mode} ${dependents === 1 ? 0 : 1}` };
        const args: ToolArguments =
          mode === "commands"
            ? {
                action: mode,
                resultDetail: "full",
                commands: [
                  { action: "update", entity: "product", id: subject.id, data },
                ],
              }
            : mode === "bulkUpdate"
              ? {
                  action: mode,
                  entity: "product",
                  ids: [subject.id],
                  data,
                  resultDetail: "full",
                }
              : {
                  action: mode,
                  entity: "product",
                  id: subject.id,
                  data,
                  resultDetail: "full",
                };
        const measured = await countTestDbQueries(() =>
          callMcpTool(
            createMcpServer(),
            "entity",
            args,
            kernelRequestContext(kernel),
            { entityKernel: kernel },
          ),
        );
        expect(measured.result.isError).not.toBe(true);
        const outcomes =
          mode === "commands"
            ? measured.result.structuredContent
            : { results: [{ status: "succeeded" }] };
        expect(outcomes).toMatchObject({ results: [{ status: "succeeded" }] });
        expect(
          measured.tables.filter((table) =>
            ["Expense", "SearchDocument"].includes(table),
          ),
        ).toEqual([]);
        expect(
          measured.statements.some(
            (statement) =>
              statement.includes("jsonb_agg") ||
              statement.includes("scheduleConnectionRefresh"),
          ),
        ).toBe(false);
        expect(measured.queryCount).toBeLessThanOrEqual(90);
        const response = JSON.stringify(measured.result.structuredContent);
        expect(response).not.toContain("Synthetic dependent expense");
        expect(response).not.toContain("recipeCoverageChanges");
        expect(response.length).toBeLessThan(2000);
        samples.push({ queries: measured.queryCount, bytes: response.length });
      }
      expect(samples[1]?.queries).toBe(samples[0]?.queries);
      expect(
        Math.abs((samples[1]?.bytes ?? 0) - (samples[0]?.bytes ?? 0)),
      ).toBeLessThanOrEqual(32);
    },
  );
});
