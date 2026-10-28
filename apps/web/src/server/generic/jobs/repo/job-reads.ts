/**
 * The read interface over Jobs for callers outside generic/jobs: rows by
 * identity, a Run's live lease, and the stopped Run executions the reconciler
 * settles. Callers never select the Job table themselves.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import { jobState, type JobState } from "@cubby/schemas/job";
import {
  type AnyColumn,
  and,
  asc,
  eq,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job, run } from "~/server/db/retained-tables";

import type { JobRow } from "./queue";

export type { JobRow };

/** Jobs by identity and state; every key narrows, an empty filter is every Job. */
export type JobFilter = {
  id?: string;
  ids?: readonly string[];
  /** The Job's shortcode. */
  code?: string;
  key?: string;
  keys?: readonly string[];
  kind?: string;
  kinds?: readonly string[];
  runId?: string;
  states?: readonly JobState[];
};

export const jobWhere = (filter: JobFilter): SQL | undefined =>
  and(
    filter.id === undefined
      ? undefined
      : eq(job.id, parseEntityId("job", filter.id)),
    filter.ids
      ? inArray(
          job.id,
          filter.ids.map((id) => parseEntityId("job", id)),
        )
      : undefined,
    filter.code === undefined ? undefined : eq(job.shortcode, filter.code),
    filter.key === undefined ? undefined : eq(job.key, filter.key),
    filter.keys ? inArray(job.key, [...filter.keys]) : undefined,
    filter.kind === undefined ? undefined : eq(job.kind, filter.kind),
    filter.kinds ? inArray(job.kind, [...filter.kinds]) : undefined,
    filter.runId === undefined
      ? undefined
      : eq(job.runId, parseEntityId("run", filter.runId)),
    filter.states ? inArray(job.state, [...filter.states]) : undefined,
  );

const ORDER = {
  availableAt: job.availableAt,
  createdAt: job.createdAt,
  id: job.id,
} as const;

/** Matching Jobs, in `order` (ascending) when given; otherwise unordered. */
export async function readJobs(
  db: RepositoryQueryInput,
  filter: JobFilter,
  options: { order?: readonly (keyof typeof ORDER)[]; limit?: number } = {},
): Promise<JobRow[]> {
  const query = repositoryQueries(db)
    .select()
    .from(job)
    .where(jobWhere(filter))
    .orderBy(...(options.order ?? []).map((column) => asc(ORDER[column])));
  return options.limit === undefined ? query : query.limit(options.limit);
}

/** One matching Job (a key, id or code identifies at most one). */
export const readJob = async (
  db: RepositoryQueryInput,
  filter: JobFilter,
): Promise<JobRow | null> =>
  (await readJobs(db, filter, { limit: 1 }))[0] ?? null;

const liveRunLease = (runId: AnyColumn | string, kind: string) =>
  and(
    typeof runId === "string"
      ? eq(job.runId, parseEntityId("run", runId))
      : eq(job.runId, runId),
    eq(job.kind, kind),
    eq(job.state, jobState.enum.running),
    sql`${job.leaseExpiresAt}>now()`,
  );

/** Whether a `kind` Job of the Run (a correlated column) holds a live lease. */
export const runJobLeaseLive = (runId: AnyColumn, kind: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM ${job} WHERE ${liveRunLease(runId, kind)})`;

/** Whether a `kind` Job of `runId` holds a live lease: its executor is mid-pass. */
export async function hasLiveRunJobLease(
  db: RepositoryQueryInput,
  runId: string,
  kind: string,
) {
  const [held] = await repositoryQueries(db)
    .select({ id: job.id })
    .from(job)
    .where(liveRunLease(runId, kind))
    .limit(1);
  return held !== undefined;
}

const STOPPED = ["failed", "cancelled", "paused"] as const;

/** Stopped `run.execute` Jobs whose Run matches `runWhere`, for the Run reconciler. */
export const stoppedRunExecutions = (
  db: RepositoryQueryInput,
  runWhere: SQL | undefined,
  limit: number,
) =>
  repositoryQueries(db)
    .select({
      id: job.id,
      generation: job.generation,
      runId: job.runId,
      state: job.state,
      error: job.error,
    })
    .from(job)
    .innerJoin(run, eq(run.id, job.runId))
    .where(
      and(eq(job.kind, "run.execute"), runWhere, inArray(job.state, STOPPED)),
    )
    .limit(limit);

/**
 * Lock the Job while it is still at this generation and state; false when it
 * moved on or another writer holds it.
 */
export async function lockUnchangedJob(
  db: RepositoryQueryInput,
  row: Pick<JobRow, "id" | "generation" | "state">,
) {
  const [current] = await repositoryQueries(db)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        eq(job.id, row.id),
        eq(job.generation, row.generation),
        eq(job.state, row.state),
      ),
    )
    .for("update", { skipLocked: true });
  return current !== undefined;
}
