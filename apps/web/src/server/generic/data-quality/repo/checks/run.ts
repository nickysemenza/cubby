import { photoRunImageState } from "@cubby/schemas/photo-import-run";
import {
  importOperationStatusOut,
  runTargetState,
} from "@cubby/schemas/purchase-import";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
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
        ${t.status} IN (${runStatus.enum.completed}, ${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed}) AND ${t.endedAt} IS NULL
      )`,
    },
    run_target_outcomes: {
      expected: (t: Run) => sql`${t.status} = ${runStatus.enum.completed} AND
        ${t.purpose} IN (${runPurpose.enum.purchase_validation}, ${runPurpose.enum.product_enrichment}, ${runPurpose.enum.photo_inventory})`,
      // Historical generic outcomes are immutable receipts; only photo membership
      // is a live work roster. Neither is an admission queue for generic research.
      missing: (
        t: Run,
      ) => sql`CASE WHEN ${t.purpose} = ${runPurpose.enum.photo_inventory} THEN
        NOT EXISTS (SELECT 1 FROM "PhotoRunImage" p WHERE p."runId" = ${t.id}) OR EXISTS (
          SELECT 1 FROM "PhotoRunImage" p WHERE p."runId" = ${t.id} AND (
            p.state NOT IN (${photoRunImageState.enum.completed}, ${photoRunImageState.enum.skipped}, ${photoRunImageState.enum.unavailable})
            OR p.outcome IS NULL OR p."completedAt" IS NULL
            OR (p.state IN (${photoRunImageState.enum.skipped}, ${photoRunImageState.enum.unavailable}) AND NULLIF(btrim(p."skipReason"), '') IS NULL)
          )
        ) ELSE
        NOT EXISTS (SELECT 1 FROM "RunOperation" o WHERE o."runId" = ${t.id} AND o.kind = ${"target_outcome"} AND o.state = ${importOperationStatusOut.shape.state.enum.completed}) OR EXISTS (
          SELECT 1 FROM "RunOperation" o WHERE o."runId" = ${t.id} AND o.kind = ${"target_outcome"} AND o.state = ${importOperationStatusOut.shape.state.enum.completed} AND (
            coalesce(o.result->${"target"}->>${"state"}, '') NOT IN (${runStatus.enum.completed}, ${runTargetState.enum.skipped}, ${runTargetState.enum.unavailable})
            OR o.result->${"target"}->>${"outcome"} IS NULL OR o.result->${"target"}->>${"completedAt"} IS NULL
            OR (o.result->${"target"}->>${"state"} IN (${runTargetState.enum.skipped}, ${runTargetState.enum.unavailable}) AND NULLIF(btrim(o.result->${"target"}->>${"warning"}), '') IS NULL)
          )
        ) END`,
    },
  },
});
