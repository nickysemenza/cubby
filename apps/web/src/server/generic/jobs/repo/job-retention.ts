import { jobState } from "@cubby/schemas/job";
import { and, eq, inArray, lt, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { FAILURE_LOOKBACK_DAYS } from "~/server/generic/jobs/repo/work-status";

const DAY_MS = 24 * 60 * 60_000;
/**
 * A completed row dedupes its key and feeds Work's pace, and a later success suppresses an
 * older failure in Work. It has to outlast that failure lookback, or a recovered kind reads
 * as failed again. Its owner holds the result.
 */
export const JOB_RETENTION_MS = (FAILURE_LOOKBACK_DAYS + 1) * DAY_MS;
/** A cancelled row records a member's stop. */
const CANCELLED_RETENTION_MS = 14 * DAY_MS;
const FAILED_RETENTION_MS = 30 * DAY_MS;

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
