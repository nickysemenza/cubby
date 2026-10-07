import { sql } from "drizzle-orm";

import { run } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Run = typeof run;

export const runChecks = defineEntityChecks({
  entity: "run",
  table: run,
  checks: {
    run_attribution: {
      missing: (t: Run) => sql`NULLIF(btrim(${t.actorName}), '') IS NULL`,
    },
    run_timeline: {
      missing: (t: Run) => sql`${t.endedAt} < ${t.startedAt} OR (
        ${t.status} IN ('completed', 'failed', 'dispatch_failed') AND ${t.endedAt} IS NULL
      )`,
    },
    run_target_outcomes: {
      expected: (t: Run) => sql`${t.status} = 'completed' AND
        ${t.purpose} IN ('purchase_validation', 'product_enrichment', 'photo_inventory')`,
      // Account sync can discover no orders. Targeted runs must account for every target;
      // skips are honest outcomes when they carry a reason. Captures are purpose-specific.
      missing: (t: Run) => sql`NOT EXISTS (
        SELECT 1 FROM "RunTarget" dq_target WHERE dq_target."runId" = ${t.id}
      ) OR EXISTS (
        SELECT 1 FROM "RunTarget" dq_target WHERE dq_target."runId" = ${t.id} AND (
          dq_target."state" NOT IN ('completed', 'skipped', 'unavailable')
          OR dq_target."outcome" IS NULL OR dq_target."completedAt" IS NULL
          OR (dq_target."state" IN ('skipped', 'unavailable') AND NULLIF(btrim(dq_target."warning"), '') IS NULL)
        )
      )`,
    },
  },
});
