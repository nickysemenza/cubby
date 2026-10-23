import type { ActorContext } from "@cubby/schemas/context";
import { userId, type RunId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run, runControlEvent } from "~/server/db/schema";

import { loadRunController } from "./control-scope";

/**
 * Records a member's "Run now, paid allowed" on a Run that has no agent scope
 * (Mail discovery); agent Runs record it through `controlRun`.
 */
export async function recordPaidGrant(
  db: Database,
  actor: ActorContext,
  input: { runId: RunId; paidOverBudgetUsd?: number },
) {
  const controller = await loadRunController(db, actor);
  if (!controller)
    throw new Error("Only a household member can allow paid AI for a Run.");
  await getDb(db)
    .insert(runControlEvent)
    .values({
      runId: input.runId,
      action: "run_now_paid",
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: controller.ledgerPartyId,
      controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
      controllerLedgerPartyName: controller.ledgerPartyName,
      controllerLedgerPartyKind: controller.ledgerPartyKind,
      paidOverBudgetUsd: input.paidOverBudgetUsd ?? null,
    });
}

// Retry chains are short; the bound only stops a corrupted cycle.
const MAX_LINEAGE = 50;

/**
 * A member's latest "Run now, paid allowed" for this Run, the retries it
 * succeeds, or the discovery Run that started any of them, with the
 * confirmed spend past the paid budget. A retry inherits its predecessor's
 * background status (`isBackgroundRun`), so it inherits the grant too.
 */
export async function readPaidGrant(db: Database, runId: RunId) {
  // Follow only predecessors; each visited Run contributes its direct parent.
  // Keep the old traversal bound and cycle fence while reading the grant fresh.
  const scope = sql`WITH RECURSIVE lineage AS (
    SELECT ${runId}::uuid AS id, ARRAY[${runId}::uuid] AS visited, 0 AS depth
    UNION ALL
    SELECT current_run."predecessorRunId",
           lineage.visited || current_run."predecessorRunId", lineage.depth + 1
    FROM lineage JOIN ${run} current_run ON current_run.id = lineage.id
    WHERE lineage.depth + 1 < ${MAX_LINEAGE}
      AND current_run."predecessorRunId" IS NOT NULL
      AND NOT (current_run."predecessorRunId" = ANY(lineage.visited))
  )
  SELECT id FROM lineage
  UNION
  SELECT current_run."parentRunId"
  FROM lineage JOIN ${run} current_run ON current_run.id = lineage.id
  WHERE current_run."parentRunId" IS NOT NULL`;
  const [grant] = await getDb(db)
    .select({
      createdAt: runControlEvent.createdAt,
      paidOverBudgetUsd: runControlEvent.paidOverBudgetUsd,
    })
    .from(runControlEvent)
    .where(
      and(
        eq(runControlEvent.action, "run_now_paid"),
        inArray(runControlEvent.runId, sql`(${scope})`),
      ),
    )
    .orderBy(desc(runControlEvent.createdAt))
    .limit(1);
  return grant ?? null;
}
