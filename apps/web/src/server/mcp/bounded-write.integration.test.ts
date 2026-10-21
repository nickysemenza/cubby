import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { costTypeSchema, tradeSchema } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import { inArray, sql } from "drizzle-orm";
import {
  countTestDbQueries,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
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

// Failures: a write traverses dependent Expenses/search projections, a batch
// misses a selected root, or it modifies an unselected record. Observe the
// prohibited reads directly; a large population and exact SQL/byte counts
// only multiply setup and break harmless refactors.
describe("bounded MCP writes", () => {
  const ctx = withTestDb("mcp");
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

  it.each(["update", "commands", "bulkUpdate"] as const)(
    "%s saves only selected roots without traversing dependents",
    async (mode) => {
      const kernel = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: testUserId(TEST_USER_ID) },
        }),
      );
      const subjects = [];
      for (let index = 0; index < 3; index++) {
        subjects.push(
          await createProductFixture(
            ctx.db,
            makeProductInput({
              name: `Synthetic bounded subject ${index}`,
              notes: "Synthetic original note",
            }),
            ctx.actor,
          ),
        );
      }
      await getDb(ctx.db).execute(sql`
        WITH roots(id) AS (VALUES ${sql.join(
          subjects.map((subject) => sql`(${subject.entityId}::uuid)`),
          sql`, `,
        )})
        INSERT INTO "Expense" (shortcode,name,cost,date,"costType",trade,"productId","lineKind")
        SELECT 'EXP-SYN' || replace(roots.id::text,'-','') || n::text,
          'Synthetic dependent expense',1,'2026-01-01',${costTypeSchema.enum.materials},${tradeSchema.enum.other},roots.id,${expenseLineKindSchema.enum.principal}
        FROM roots CROSS JOIN generate_series(1,3) n
      `);
      const selected = subjects.slice(0, mode === "update" ? 1 : 2);
      const data = { notes: "Synthetic saved note" };
      const args: ToolArguments =
        mode === "commands"
          ? {
              action: mode,
              resultDetail: "full",
              commands: selected.map((subject) => ({
                action: "update",
                entity: "product",
                id: subject.id,
                data,
              })),
            }
          : mode === "bulkUpdate"
            ? {
                action: mode,
                entity: "product",
                ids: selected.map((subject) => subject.id),
                data,
                resultDetail: "full",
              }
            : {
                action: mode,
                entity: "product",
                id: selected[0]!.id,
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
      expect(
        measured.tables.filter((table) =>
          ["Expense", "SearchDocument"].includes(table),
        ),
      ).toEqual([]);
      const saved = await getDb(ctx.db)
        .select({ id: product.id, notes: product.notes })
        .from(product)
        .where(
          inArray(
            product.id,
            subjects.map((subject) => subject.entityId),
          ),
        );
      for (const subject of subjects) {
        expect(saved.find((row) => row.id === subject.entityId)?.notes).toBe(
          selected.includes(subject) ? data.notes : "Synthetic original note",
        );
      }
    },
  );
});
