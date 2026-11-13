import type { RunId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import {
  purchaseAgentEvent,
  type PurchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import { runStatus } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { runAfterCommit, withTransaction } from "~/server/db/helpers/core";
import { notDeleted } from "~/server/db/helpers/predicates";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { wakeAfterCommit } from "~/server/kernel/wake";

import { runPurposeLifecycle } from "./purpose-lifecycle";

const EVENT_QUEUE = "events";

/** Commit handoff intent with admission. Retries retain one operation identity. */
async function dispatchRunEvent(
  db: RepositoryQueryInput,
  submitted: PurchaseAgentEvent,
) {
  const event = purchaseAgentEvent.parse(submitted);
  await repositoryQueries(db)
    .execute(sql`INSERT INTO "Pass" (name, key, "runId", cursor)
    VALUES ('purchase.dispatch', ${event.runId}, ${event.runId}::uuid,
      ${JSON.stringify({ runId: event.runId, events: [event] })}::jsonb)
    ON CONFLICT (name, key) DO UPDATE SET
      cursor = coalesce("Pass".cursor, '{}'::jsonb) || jsonb_build_object('runId', excluded.key, ${EVENT_QUEUE}::text,
        CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL THEN excluded.cursor->${EVENT_QUEUE}::text
          WHEN coalesce("Pass".cursor->${EVENT_QUEUE}::text, '[]'::jsonb) @> (excluded.cursor->${EVENT_QUEUE}::text) THEN "Pass".cursor->${EVENT_QUEUE}::text
          ELSE coalesce("Pass".cursor->${EVENT_QUEUE}::text, '[]'::jsonb) || (excluded.cursor->${EVENT_QUEUE}::text) END),
      "claimToken" = CASE WHEN "Pass"."cancelledAt" IS NOT NULL THEN NULL ELSE "Pass"."claimToken" END,
      "claimDeadline" = CASE WHEN "Pass"."cancelledAt" IS NOT NULL THEN NULL ELSE "Pass"."claimDeadline" END,
      "doneAt" = NULL, "cancelledAt" = NULL, "availableAt" = now(), attempts = 0,
      "waitCause" = NULL, "wakeVersion" = "Pass"."wakeVersion" + 1, "updatedAt" = now()`);
  await runAfterCommit(db, (committed) => wakeAfterCommit(committed));
}

export async function dispatchStartedRun(
  db: RepositoryQueryInput,
  run: { id: RunId; eventId: string; purpose: string },
): Promise<"running"> {
  await dispatchRunEvent(db, {
    version: 1,
    runId: run.id,
    purpose: agentImportRunPurpose.parse(run.purpose),
    eventId: run.eventId,
    generation: run.eventId,
    type: "start_or_resume",
  });
  return "running";
}

/** Only the current unstarted generation can inherit terminal Pass diagnostics. */
const failedUnstartedDispatch = sql`j.name='purchase.dispatch' AND j.attempts >= j."maxAttempts" AND j."runId"=r.id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.cursor->${EVENT_QUEUE}::text) event WHERE event->>'type'='start_or_resume' AND event->>'eventId'=r."dispatchEventId"::text)
      AND r.status=${runStatus.enum.running} AND r."coordinatorStartedAt" IS NULL AND r."retiredAt" IS NULL AND ${notDeleted("r")}`;

/** Returns how many Runs it failed. */
export async function reconcileCoordinatorDispatches(db: Database) {
  return withTransaction(db, async (tx) => {
    const rows = await tx.execute<{
      id: RunId;
      purpose: string;
    }>(
      sql`UPDATE "Run" r SET status=${runStatus.enum.dispatch_failed}, "failureCode"=${runStatus.enum.dispatch_failed},
    "dispatchError"=j."lastError", "endedAt"=now(), "updatedAt"=now()
    FROM "Pass" j WHERE ${failedUnstartedDispatch}
      RETURNING r.id, r.purpose`,
      "objects",
    );
    for (const { id, purpose } of rows)
      await (await runPurposeLifecycle(purpose))?.dispatchFailed?.(tx, id);
    return rows.length;
  });
}

/** Runs with owed or claimed coordinator work are alive even before their first progress write. */
export async function activeCoordinatorRuns(db: Database): Promise<string[]> {
  const result = await repositoryQueries(db).execute<{ runId: string }>(
    sql`SELECT "runId" FROM "Pass" WHERE name = 'purchase.dispatch' AND "doneAt" IS NULL AND "cancelledAt" IS NULL AND attempts < "maxAttempts" AND "runId" IS NOT NULL`,
  );
  return result.rows.map((row) => row.runId);
}
