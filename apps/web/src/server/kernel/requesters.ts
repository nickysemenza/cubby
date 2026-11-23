/** Run intent belongs to its requester link; shared Answers outlive a Run. */
import { askState } from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { wakeAfterCommit } from "./wake";

export async function cancelRunAsks(db: Database, runId: string) {
  const result = await repositoryQueries(db).execute<{ askId: string }>(sql`
    UPDATE "AskScope" SET "cancelledAt" = coalesce("cancelledAt", now())
    WHERE "runId" = ${runId}::uuid AND "cancelledAt" IS NULL RETURNING "askId"`);
  return result.rows.length;
}

/**
 * Explicit Run retry revives its demand and exhausted unsent calls, never
 * unknown calls. Revived Asks are due now, so this sends its own commit wake:
 * the Run's Pass may keep a later funding deadline.
 */
export async function retryRunAsks(db: Database, runId: string) {
  const q = repositoryQueries(db);
  const revived = await q.execute<{ askId: string }>(sql`
    UPDATE "AskScope" SET "cancelledAt" = NULL
    WHERE "runId" = ${runId}::uuid AND "cancelledAt" IS NOT NULL RETURNING "askId"`);
  const reset = await q.execute<{ id: string }>(sql`
    UPDATE "Ask" a SET attempts = 0, "availableAt" = now(), "lastError" = NULL
    WHERE a.state = ${askState.enum.queued} AND a.attempts >= a."maxAttempts"
      AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = a.id AND s."runId" = ${runId}::uuid)
    RETURNING a.id`);
  if (revived.rows.length || reset.rows.length) await wakeAfterCommit(db);
}
