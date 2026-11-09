import { jobState } from "@cubby/schemas/job";
import { runCause, runStatus, runTrigger } from "@cubby/schemas/run-fields";
import {
  and,
  eq,
  exists,
  inArray,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/db/helpers";
import { job, run } from "~/server/db/retained-tables";

const DAY_MS = 24 * 60 * 60_000;
/**
 * A completed row dedupes its key and feeds Work's pace, and a later success suppresses an
 * older failure in Work. It has to outlast that failure lookback, or a recovered kind reads
 * as failed again. Its owner holds the result.
 */
const JOB_RETENTION_MS = 8 * DAY_MS;
/** A cancelled row records a member's stop. */
const CANCELLED_RETENTION_MS = 14 * DAY_MS;
/** A failed row with no qualifying Run keeps the longer window. */
const FAILED_RETENTION_MS = 30 * DAY_MS;
/**
 * A failed row whose Run is settled, scheduled work no member asked for and not
 * mail or financial import work. Rows are the only thing deleted: the Run stays
 * as AiUsage cost evidence.
 */
const FAILED_RUN_JOB_RETENTION_MS = 14 * DAY_MS;
const KEPT_FAILURE_PURPOSES = [
  "mail_import",
  "mail_discovery",
  "mail_search",
  "mail_reclassify",
  "purchase_validation",
  "account_sync",
] as const;

/**
 * Delete one bounded batch of finished execution rows. Domain evidence lives
 * on its own tables.
 */
export async function pruneFinishedJobs(
  db: Database,
  { limit, now = new Date() }: { limit: number; now?: Date },
): Promise<number> {
  const olderThan = (retentionMs: number) =>
    lt(job.updatedAt, new Date(now.getTime() - retentionMs));
  return withTransaction(db, async (tx) => {
    const doomed = tx
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          or(
            and(
              eq(job.state, jobState.enum.completed),
              olderThan(JOB_RETENTION_MS),
            ),
            and(
              eq(job.state, jobState.enum.cancelled),
              olderThan(CANCELLED_RETENTION_MS),
            ),
            and(
              eq(job.state, jobState.enum.failed),
              olderThan(FAILED_RETENTION_MS),
            ),
            and(
              eq(job.state, jobState.enum.failed),
              olderThan(FAILED_RUN_JOB_RETENTION_MS),
              // includes-deleted: a soft-deleted Run's failed Jobs are still prunable.
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(run)
                  .where(
                    and(
                      eq(run.id, job.runId),
                      inArray(run.status, [
                        runStatus.enum.completed,
                        runStatus.enum.failed,
                        runStatus.enum.dispatch_failed,
                      ]),
                      ne(run.trigger, runTrigger.enum.manual),
                      sql`${run.cause} IS DISTINCT FROM ${runCause.enum.member_request}`,
                      notInArray(run.purpose, [...KEPT_FAILURE_PURPOSES]),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .limit(limit)
      .for("update", { skipLocked: true });
    const deleted = await tx
      .delete(job)
      .where(inArray(job.id, doomed))
      .returning({ id: job.id });
    return deleted.length;
  });
}
