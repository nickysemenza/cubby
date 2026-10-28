/**
 * The operator interface: member and Run controls over durable Jobs. Manual
 * pause, cancellation and exhausted failure stay stopped until one of these.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import { jobState } from "@cubby/schemas/job";
import { and, eq, gt, inArray, is, isNotNull, SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";
import { jobWhere, type JobFilter } from "~/server/generic/jobs/repo/job-reads";

const ACTIVE = ["queued", "running", "retry_wait", "paused"] as const;
const stopped = {
  waitReason: null,
  waitUntil: null,
  leaseToken: null,
  leaseExpiresAt: null,
};

/** Reopen one stopped Job with a fresh budget and generation. */
export async function retryJob(db: RepositoryQueryInput, id: string) {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      ...stopped,
      state: "queued",
      attempts: 0,
      generation: sql`${job.generation} + 1`,
      error: null,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, parseEntityId("job", id)),
        inArray(job.state, ["failed", "paused", "cancelled"]),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Retry now, set-based: matching Jobs become due immediately with backoff and
 * provider waits cleared; prior errors stay for diagnosis. Failed and
 * cancelled Jobs reopen with a fresh attempt budget and generation. Running
 * and member-paused Jobs are left alone.
 */
export async function retryJobsNow(
  db: RepositoryQueryInput,
  where: SQL | JobFilter,
) {
  const now = new Date();
  const reopened = await repositoryQueries(db)
    .update(job)
    .set({
      ...stopped,
      state: "queued",
      attempts: 0,
      generation: sql`CASE WHEN ${job.state} IN (${jobState.enum.failed}, ${jobState.enum.cancelled}) THEN ${job.generation} + 1 ELSE ${job.generation} END`,
      availableAt: now,
      updatedAt: now,
    })
    .where(
      and(
        is(where, SQL) ? where : jobWhere(where),
        inArray(job.state, ["queued", "retry_wait", "failed", "cancelled"]),
      ),
    )
    .returning({ id: job.id });
  return reopened.map((row) => row.id);
}

/** A member launch outranks the Job's earlier priority. */
export async function prioritizeJob(
  db: RepositoryQueryInput,
  id: string,
  priority: number,
) {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({ priority })
    .where(eq(job.id, parseEntityId("job", id)))
    .returning();
  return row ?? null;
}

/**
 * Queued or backing-off Jobs whose key is in `keys` (a key subquery) become
 * due now; typed waits and attempts stay.
 */
export async function makeJobsDueNow(db: RepositoryQueryInput, keys: SQL) {
  await repositoryQueries(db)
    .update(job)
    .set({ availableAt: new Date() })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait"]),
        sql`${job.key} IN (${keys})`,
      ),
    );
}

async function controlJob(
  db: RepositoryQueryInput,
  id: string,
  state: "paused" | "cancelled",
) {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      ...stopped,
      state,
      generation: sql`${job.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(job.id, parseEntityId("job", id)), inArray(job.state, ACTIVE)),
    )
    .returning();
  return row ?? null;
}

export const cancelJob = (db: RepositoryQueryInput, id: string) =>
  controlJob(db, id, "cancelled");

export const pauseJob = (db: RepositoryQueryInput, id: string) =>
  controlJob(db, id, "paused");

/**
 * Cancel every active Job matching `where` in one statement. Callers holding
 * a global lock must never loop per row.
 */
export async function cancelJobsWhere(db: RepositoryQueryInput, where: SQL) {
  return repositoryQueries(db)
    .update(job)
    .set({
      ...stopped,
      state: "cancelled",
      generation: sql`${job.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(and(where, inArray(job.state, ACTIVE)))
    .returning({ id: job.id });
}

/**
 * A cancelled Run stops its own Jobs. Never-exhausting work (image
 * processing) belongs to its subject, not the Run that requested it: it
 * keeps running and only loses the Run's priority.
 */
export async function cancelRunJobs(db: RepositoryQueryInput, runId: string) {
  await repositoryQueries(db)
    .update(job)
    .set({ ...stopped, state: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(job.runId, parseEntityId("run", runId)),
        inArray(job.state, ACTIVE),
        isNotNull(job.maxAttempts),
      ),
    );
}

/** A larger member budget may bring due work forward; stopped Jobs stay stopped. */
export async function bringQueuedJobsForward(db: Database, now: Date) {
  return repositoryQueries(db)
    .update(job)
    .set({ availableAt: now, waitUntil: null, waitReason: null })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait"]),
        gt(job.availableAt, now),
      ),
    )
    .returning({ id: job.id });
}
