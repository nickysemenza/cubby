/**
 * The read interface over Jobs for callers outside generic/jobs: rows by
 * identity and state. Callers never select the Job table themselves.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import { jobState, type JobState } from "@cubby/schemas/job";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { related } from "~/server/db/helpers/related";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";

import type { JobRow } from "./queue";

export type { JobRow };

/** Any retained execution obligation, including paused and not-yet-due retries. */
export const runHasLiveJobs = (runId: SQL): SQL<boolean> =>
  related(job, (item) => sql`${item.runId} = ${runId}`)
    .where(
      (item) =>
        sql`${item.state} IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running}, ${jobState.enum.paused})`,
    )
    .exists();

/** Jobs by identity and state; every key narrows, an empty filter is every Job. */
export type JobFilter = {
  id?: string;
  ids?: readonly string[];
  /** The Job's shortcode. */
  key?: string;
  keys?: readonly string[];
  kind?: string;
  kinds?: readonly string[];
  runId?: string;
  states?: readonly JobState[];
};

export const jobWhere = (filter: JobFilter): SQL | undefined =>
  and(
    filter.id === undefined ? undefined : eq(job.id, filter.id),
    filter.ids ? inArray(job.id, [...filter.ids]) : undefined,
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
