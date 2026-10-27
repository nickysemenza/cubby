import { jobState } from "@cubby/schemas/job";
import { and, eq, inArray, lt } from "drizzle-orm";

import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { getDb, withTransaction } from "~/server/db/helpers";
import { job, jobInvalidationCapture } from "~/server/db/retained-tables";

/** Completed and cancelled Jobs older than this are pruned; failed ones stay. */
export const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;

/**
 * Delete one bounded batch of finished execution rows. Domain evidence lives
 * on its own tables; each pruned Job's entity identity is removed atomically.
 */
export async function pruneFinishedJobs(
  db: Database,
  { limit, now = new Date() }: { limit: number; now?: Date },
): Promise<number> {
  const before = new Date(now.getTime() - JOB_RETENTION_MS);
  return withTransaction(db, async (tx) => {
    const doomed = tx
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          inArray(job.state, [
            jobState.enum.completed,
            jobState.enum.cancelled,
          ]),
          lt(job.updatedAt, before),
        ),
      )
      .limit(limit)
      .for("update", { skipLocked: true });
    const deleted = await tx
      .delete(job)
      .where(inArray(job.id, doomed))
      .returning({ id: job.id });
    if (deleted.length)
      await tx.delete(entityIdentity).where(
        and(
          eq(entityIdentity.kind, "job"),
          inArray(
            entityIdentity.id,
            deleted.map((row) => row.id),
          ),
        ),
      );
    return deleted.length;
  });
}

/** Delete one bounded batch of invalidation captures already observed by a Job. */
export async function pruneObservedInvalidationCaptures(
  db: Database,
  { limit }: { limit: number },
): Promise<number> {
  const doomed = getDb(db)
    .select({ id: jobInvalidationCapture.id })
    .from(jobInvalidationCapture)
    .where(eq(jobInvalidationCapture.observed, true))
    .limit(limit);
  const deleted = await getDb(db)
    .delete(jobInvalidationCapture)
    .where(inArray(jobInvalidationCapture.id, doomed))
    .returning({ id: jobInvalidationCapture.id });
  return deleted.length;
}
