import { readFileSync, writeFileSync } from "node:fs";

import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { listEntities } from "~/entity/generated/entity-lists.gen";
import { withDatabaseOperationMetrics } from "~/server/db/db-observability";
import { executeEntity } from "~/server/entity-kernel";
import {
  buildKernelContext,
  seedReferenceUniverse,
} from "~/server/entity-kernel/reference-universe.fixtures";

// Failure mode: list latency in production is round trips, about 50-75 ms
// each through Hyperdrive. A loader that waits on another loader, or a
// per-row query, adds a round trip to every page of every list it touches.
// Each entity's default page is pinned to its measured statements and
// sequential round trips; the budget only moves down.
const BUDGET_FILE = new URL("./list-query-budget.json", import.meta.url);
const pageBudget = z.object({
  statements: z.number().int().nonnegative(),
  serial: z.number().int().nonnegative(),
});
const budgets = z
  .record(z.string(), pageBudget)
  .parse(JSON.parse(readFileSync(BUDGET_FILE, "utf8")));

describe("entity list query budget", () => {
  const ctx = withTestDb();

  it("keeps every entity's default page within its round-trip budget", async () => {
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    const measured: Record<string, z.infer<typeof pageBudget>> = {};
    const report: string[] = [];
    for (const entity of listEntities) {
      // A warm read: first-use module and manifest work is not a page cost.
      const read = () =>
        executeEntity(context, {
          action: "list",
          entity,
          filters: {},
          pagination: { pageIndex: 0, pageSize: 25 },
        });
      await read();
      // Branches that start a tick apart can miss each other, so one read
      // can show an extra serial start; the fewest over three is the shape.
      const samples = [];
      for (let attempt = 0; attempt < 3; attempt++)
        samples.push(
          await countTestDbQueries(() =>
            withDatabaseOperationMetrics(async (metrics) => {
              await read();
              return {
                statements: metrics.queryCount,
                serial: metrics.querySerialStarts,
              };
            }),
          ),
        );
      const { statements } = samples[0]!;
      const result = {
        statements: Math.max(...samples.map((s) => s.result.statements)),
        serial: Math.min(...samples.map((s) => s.result.serial)),
      };
      measured[entity] = result;
      report.push(
        `## ${entity} statements=${result.statements} serial=${result.serial}`,
        ...statements,
      );
    }
    if (process.env.CUBBY_LIST_BUDGET_REPORT)
      writeFileSync(process.env.CUBBY_LIST_BUDGET_REPORT, report.join("\n"));
    if (process.env.CUBBY_LIST_BUDGET_WRITE) {
      writeFileSync(BUDGET_FILE, `${JSON.stringify(measured, null, 2)}\n`);
      return;
    }
    const over = Object.entries(measured).filter(([entity, page]) => {
      const budget = budgets[entity];
      return (
        !budget ||
        page.statements > budget.statements ||
        page.serial > budget.serial
      );
    });
    expect(
      Object.fromEntries(over),
      "over budget; lower list-query-budget.json only after a measured fix",
    ).toEqual({});
  });
});
