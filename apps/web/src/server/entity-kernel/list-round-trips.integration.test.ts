import { execFileSync } from "node:child_process";
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

// Non-blocking performance evidence (docs/agents/validation.md, Performance
// review): list latency in production is round trips, about 50-75 ms each
// through Hyperdrive. This report reads every entity's default page and
// records its statements and query busy intervals beside the recorded
// baseline. Run it with CUBBY_LIST_EVIDENCE=<output file>; it never gates CI.
const BASELINE_FILE = new URL(
  "./list-round-trips.baseline.json",
  import.meta.url,
);
const pageWork = z.object({
  statements: z.number().int().nonnegative(),
  busyIntervals: z.number().int().nonnegative(),
});
const provenance = z.object({
  revision: z.string(),
  environment: z.string(),
  workload: z.string(),
  unavailable: z.array(z.string()),
});
const WORKLOAD =
  "seedReferenceUniverse, kernel list default page of 25, warm (minimum busy intervals over three reads)";
const UNAVAILABLE = [
  "production latency",
  "plan work",
  "response bytes",
  "time to useful data",
];
const output = process.env.CUBBY_LIST_EVIDENCE;

describe.skipIf(!output)("entity list round-trip evidence", () => {
  const ctx = withTestDb();

  it("reports every entity's default page", async () => {
    const baseline = z
      .object({ provenance, pages: z.record(z.string(), pageWork) })
      .parse(JSON.parse(readFileSync(BASELINE_FILE, "utf8")));
    await seedReferenceUniverse(ctx.db);
    const context = buildKernelContext(ctx.db);
    const measured: Record<string, z.infer<typeof pageWork>> = {};
    const statementsByEntity: Record<string, string[]> = {};
    for (const entity of listEntities) {
      const read = () =>
        executeEntity(context, {
          action: "list",
          entity,
          filters: {},
          pagination: { pageIndex: 0, pageSize: 25 },
        });
      // A warm read: first-use module and manifest work is not a page cost.
      await read();
      // Branches that start a tick apart can miss each other, so one read can
      // show an extra interval; the fewest over three is the page's shape.
      const samples = [];
      for (let attempt = 0; attempt < 3; attempt++)
        samples.push(
          await countTestDbQueries(() =>
            withDatabaseOperationMetrics(async (metrics) => {
              await read();
              return {
                statements: metrics.queryCount,
                busyIntervals: metrics.queryBusyIntervals,
              };
            }),
          ),
        );
      measured[entity] = {
        statements: Math.max(...samples.map((s) => s.result.statements)),
        busyIntervals: Math.min(...samples.map((s) => s.result.busyIntervals)),
      };
      statementsByEntity[entity] = samples[0]?.statements ?? [];
    }
    // A page that issued no statement was not measured (a stubbed or
    // short-circuited read), so the report would be empty for it.
    expect(
      Object.entries(measured).filter(([, page]) => page.statements === 0),
    ).toEqual([]);
    writeFileSync(
      output!,
      JSON.stringify(
        {
          provenance: {
            revision: execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            environment: `local IntegreSQL database, ${process.platform}`,
            workload: WORKLOAD,
            unavailable: UNAVAILABLE,
          },
          baseline: baseline.provenance,
          measured,
          changedFromBaseline: Object.fromEntries(
            Object.entries(measured).flatMap(([entity, page]) => {
              const before = baseline.pages[entity];
              return before &&
                before.statements === page.statements &&
                before.busyIntervals === page.busyIntervals
                ? []
                : [[entity, { before: before ?? null, after: page }]];
            }),
          ),
          statements: statementsByEntity,
        },
        null,
        2,
      ),
    );
  });
});
