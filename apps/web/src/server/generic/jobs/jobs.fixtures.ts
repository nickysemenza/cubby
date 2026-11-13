/**
 * Test support for Job state the queue owns: tests seed, age, lock and inspect
 * rows here instead of importing the table. Reads go through `job-reads.ts`.
 */
import { sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";
import {
  jobWhere,
  type JobFilter,
  type JobRow,
} from "~/server/generic/jobs/repo/job-reads";

/** Insert bare queued Jobs in one statement, for backlog-shaped fixtures. */
export const seedJobs = (
  db: RepositoryQueryInput,
  rows: readonly { key: string; kind: string; input: Record<string, never> }[],
): Promise<JobRow[]> =>
  repositoryQueries(db)
    .insert(job)
    .values([...rows])
    .returning();

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

/** Claim and settle a Job in a test, as the drain executor would. */
export { claimJob, type JobClaim } from "~/server/generic/jobs/repo/queue";
