/**
 * Test support for Job and WorkItem state the drain owns: tests seed, age,
 * lock and inspect rows here instead of importing the tables. Reads go
 * through `job-reads.ts` and `work-items.ts`.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgInsertValue, PgUpdateSetSource } from "drizzle-orm/pg-core";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  job,
  jobInvalidationCapture,
  jobLaneAdmission,
  workItem,
} from "~/server/db/retained-tables";
import {
  jobWhere,
  type JobFilter,
  type JobRow,
} from "~/server/generic/jobs/repo/job-reads";

/** The drain's lease heartbeat, for tests that renew a claim mid-page. */
export { renewJob } from "~/server/generic/jobs/repo/queue";

/** Write Job columns directly: a forced state, an aged lease, a test-only priority. */
export const updateJobs = (
  db: RepositoryQueryInput,
  filter: JobFilter,
  values: PgUpdateSetSource<typeof job>,
): Promise<JobRow[]> =>
  repositoryQueries(db)
    .update(job)
    .set(values)
    .where(jobWhere(filter))
    .returning();

export const deleteJobs = (db: RepositoryQueryInput, filter: JobFilter) =>
  repositoryQueries(db).delete(job).where(jobWhere(filter));

/** Row-lock matching Jobs in the caller's transaction, as a concurrent claim would. */
export const lockJobs = (
  db: RepositoryQueryInput,
  filter: JobFilter,
): Promise<JobRow[]> =>
  repositoryQueries(db)
    .select()
    .from(job)
    .where(jobWhere(filter))
    .for("update");

/** A newer claim replaced the execution: its generation moves on. */
export const replaceJobGeneration = (
  db: RepositoryQueryInput,
  filter: JobFilter,
) =>
  repositoryQueries(db)
    .update(job)
    .set({ generation: sql`${job.generation} + 1` })
    .where(jobWhere(filter));

/** Time passes: every Job's availability and lease move `interval` back. */
export const elapseJobTime = (db: RepositoryQueryInput, interval: string) =>
  repositoryQueries(db)
    .update(job)
    .set({
      availableAt: sql`${job.availableAt} - ${interval}::interval`,
      leaseExpiresAt: sql`${job.leaseExpiresAt} - ${interval}::interval`,
    });

/** Invalidation captures per Job key (all keys, or one), in key order. */
export const jobInvalidationCaptureCounts = (
  db: RepositoryQueryInput,
  key?: string,
) =>
  repositoryQueries(db)
    .select({
      key: jobInvalidationCapture.key,
      captures: sql<number>`count(*)::int`,
    })
    .from(jobInvalidationCapture)
    .where(key === undefined ? undefined : eq(jobInvalidationCapture.key, key))
    .groupBy(jobInvalidationCapture.key)
    .orderBy(jobInvalidationCapture.key);

/** Set a lane's fairness streak, as earlier device pulls would have. */
export const seedJobLaneAdmission = (
  db: RepositoryQueryInput,
  lane: string,
  ownedStreak: number,
) =>
  repositoryQueries(db)
    .insert(jobLaneAdmission)
    .values({ lane, ownedStreak })
    .onConflictDoUpdate({
      target: jobLaneAdmission.lane,
      set: { ownedStreak },
    });

/** WorkItems by drain, target and refs; every key narrows, an empty filter is every item. */
type WorkItemFilter = {
  drain?: string;
  target?: string;
  refs?: readonly string[];
};

const workItemWhere = (filter: WorkItemFilter) =>
  and(
    filter.drain === undefined ? undefined : eq(workItem.drain, filter.drain),
    filter.target === undefined
      ? undefined
      : eq(workItem.target, filter.target),
    filter.refs ? inArray(workItem.ref, [...filter.refs]) : undefined,
  );

/** Matching WorkItems with their full retry state, by target and ref. */
export const readWorkItems = (
  db: RepositoryQueryInput,
  filter: WorkItemFilter = {},
) =>
  repositoryQueries(db)
    .select()
    .from(workItem)
    .where(workItemWhere(filter))
    .orderBy(asc(workItem.target), asc(workItem.ref));

/** Write WorkItem retry state directly. */
export const updateWorkItems = (
  db: RepositoryQueryInput,
  filter: WorkItemFilter,
  values: PgUpdateSetSource<typeof workItem>,
) =>
  repositoryQueries(db)
    .update(workItem)
    .set(values)
    .where(workItemWhere(filter));

/** Seed items as a writer that predates the triggers (or a fixed mark time) would. */
export const insertWorkItems = (
  db: RepositoryQueryInput,
  rows: PgInsertValue<typeof workItem>[],
) => repositoryQueries(db).insert(workItem).values(rows);

export const deleteWorkItems = (
  db: RepositoryQueryInput,
  filter: WorkItemFilter = {},
) => repositoryQueries(db).delete(workItem).where(workItemWhere(filter));
