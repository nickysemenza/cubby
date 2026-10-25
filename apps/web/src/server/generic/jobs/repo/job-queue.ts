import { runShortcode, type RunId } from "@cubby/schemas/identifiers";
import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobLane,
  jobState,
  jobWaitingOnReason,
  type JobLane,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import { runStatus } from "@cubby/schemas/run-fields";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import {
  and,
  desc,
  eq,
  inArray,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type {
  JobFacts,
  JobSetFilter,
  RunRollup,
} from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { run } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  JOB_KIND_POLICY,
  jobKindPolicy,
} from "~/server/generic/jobs/kind-policy";
import { retryJobsNow, type JobRow } from "~/server/generic/jobs/repo/jobs";
import {
  jobWaitingOnReasonSql,
  loadJobWaitingOn,
} from "~/server/generic/jobs/repo/waiting-on";

/** A Run whose live Jobs saw no claim or completion for this long is stalled. */
export const RUN_STALL_MS = 15 * 60_000;

const LIVE_STATES = [
  jobState.enum.queued,
  jobState.enum.running,
  jobState.enum.retry_wait,
  jobState.enum.paused,
] as const;

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Kinds declared on a lane; `server` also owns every undeclared kind. */
function laneWhere(lanes: readonly JobLane[]): SQL {
  const declared = Object.entries(JOB_KIND_POLICY);
  const kindsOf = (lane: JobLane) =>
    declared.filter(([, policy]) => policy.lane === lane).map(([kind]) => kind);
  const elsewhere = declared
    .filter(([, policy]) => policy.lane !== "server")
    .map(([kind]) => kind);
  const parts = lanes.map((lane) => {
    const kinds = kindsOf(lane);
    if (lane !== "server")
      return kinds.length ? inArray(job.kind, kinds) : sql`false`;
    return elsewhere.length ? notInArray(job.kind, elsewhere) : sql`true`;
  });
  return or(...parts) ?? sql`false`;
}

/** The SQL predicate of a filtered Job set, shared by the list, counts and Retry now. */
export function jobSetWhere(
  filter: JobSetFilter,
  runId: RunId | null,
): SQL | undefined {
  return and(
    filter.states
      ? inArray(job.state, filter.states)
      : inArray(job.state, [...LIVE_STATES]),
    filter.lanes ? laneWhere(filter.lanes) : undefined,
    filter.kinds ? inArray(job.kind, filter.kinds) : undefined,
    filter.reasons
      ? sql`${jobWaitingOnReasonSql()} IN (${sql.join(
          filter.reasons.map((reason) => sql`${reason}`),
          sql`, `,
        )})`
      : undefined,
    runId ? eq(job.runId, runId) : undefined,
    filter.ids ? inArray(job.id, filter.ids) : undefined,
    filter.needsAttention
      ? or(
          eq(job.state, jobState.enum.failed),
          sql`${job.attempts} >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}`,
        )
      : undefined,
  );
}

/** Public facts for listed Jobs, with their waiting-on and owning Run code. */
export async function jobFactsOf(
  db: Database,
  rows: readonly JobRow[],
  now = new Date(),
): Promise<JobFacts[]> {
  const runIds = [
    ...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : []))),
  ];
  const [waiting, runs] = await Promise.all([
    loadJobWaitingOn(db, rows, now),
    runIds.length
      ? getDb(db)
          .select({ id: run.id, shortcode: run.shortcode })
          .from(run)
          .where(inArray(run.id, runIds))
      : Promise.resolve([]),
  ]);
  const codes = new Map(runs.map((row) => [row.id, row.shortcode]));
  return rows.map((row) => {
    const waitingOn = waiting.get(row.id) ?? null;
    const runCode = row.runId ? (codes.get(row.runId) ?? null) : null;
    return {
      id: row.id,
      key: row.key,
      kind: row.kind,
      state: row.state,
      generation: row.generation,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      priority: row.priority,
      waitReason: row.waitReason,
      waitUntil: iso(row.waitUntil),
      availableAt: row.availableAt.toISOString(),
      leaseExpiresAt: iso(row.leaseExpiresAt),
      error: row.error === null ? null : scrubErrorMessage(row.error),
      cursor: row.cursor,
      subject:
        row.subjectKind && row.subjectId
          ? { kind: row.subjectKind, id: row.subjectId }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ahead:
        waitingOn?.reason === "due" || waitingOn?.reason === "waiting_device"
          ? waitingOn.aheadCount
          : null,
      lane: jobKindPolicy(row.kind).lane,
      waitingOn,
      runId: runCode ? runShortcode.parse(runCode) : null,
    };
  });
}

/** Counts by lane and reason for the whole set, and one page of its Jobs. */
export async function readJobQueue(
  db: Database,
  input: {
    filter: JobSetFilter;
    runId: RunId | null;
    pageIndex: number;
    pageSize: number;
  },
) {
  const where = jobSetWhere(input.filter, input.runId);
  const reason = jobWaitingOnReasonSql();
  const [tallies, rows] = await Promise.all([
    getDb(db)
      .select({
        kind: job.kind,
        reason: sql<JobWaitingOnReason | null>`${reason}`,
        count: sql<number>`count(*)::int`,
      })
      .from(job)
      .where(where)
      // By position: a parameterized expression never matches its own GROUP BY copy.
      .groupBy(sql`1`, sql`2`),
    getDb(db)
      .select()
      .from(job)
      .where(where)
      .orderBy(desc(job.updatedAt), desc(job.id))
      .limit(input.pageSize)
      .offset(input.pageIndex * input.pageSize),
  ]);
  const counts = new Map<string, number>();
  let total = 0;
  for (const tally of tallies) {
    total += tally.count;
    const parsed = jobWaitingOnReason.safeParse(tally.reason);
    if (!parsed.success) continue;
    const key = `${jobKindPolicy(tally.kind).lane}:${parsed.data}`;
    counts.set(key, (counts.get(key) ?? 0) + tally.count);
  }
  return {
    counts: [...counts].map(([key, count]) => {
      const [lane, reason] = key.split(":");
      return {
        lane: jobLane.parse(lane),
        reason: jobWaitingOnReason.parse(reason),
        count,
      };
    }),
    total,
    jobs: await jobFactsOf(db, rows),
  };
}

/** Retry now over a filtered set in one transaction; returns the Jobs it made due. */
export async function retryJobSet(
  db: Database,
  filter: JobSetFilter,
  runId: RunId | null,
) {
  const where = jobSetWhere(
    { ...filter, states: filter.states ?? ["queued", "retry_wait", "failed"] },
    runId,
  );
  if (!where) return [];
  return withTransactionDatabase(db, async (tx) => {
    const ids = await retryJobsNow(tx, where);
    if (ids.length)
      await recordChange(tx, { kind: "source", categories: ["run"] });
    return ids;
  });
}

/**
 * Each Run's live Jobs by waiting-on reason, its own funding wait, and the
 * stall flag: live work remains but nothing was claimed or finished for
 * `RUN_STALL_MS`.
 */
export async function readRunRollups(
  db: Database,
  runs: readonly { id: RunId; shortcode: string }[],
  now = new Date(),
): Promise<RunRollup[]> {
  if (!runs.length) return [];
  const ids = runs.map((entry) => entry.id);
  const reason = jobWaitingOnReasonSql();
  const [tallies, progress, owners] = await Promise.all([
    getDb(db)
      .select({
        runId: job.runId,
        reason: sql<JobWaitingOnReason | null>`${reason}`,
        count: sql<number>`count(*)::int`,
      })
      .from(job)
      .where(and(inArray(job.runId, ids), inArray(job.state, [...LIVE_STATES])))
      .groupBy(sql`1`, sql`2`),
    getDb(db)
      .select({
        runId: job.runId,
        // Decoded as the UTC timestamp column it is, not as local time.
        last: sql<Date | null>`max(greatest(${job.lastClaimedAt}, CASE WHEN ${job.state} = ${jobState.enum.completed} THEN ${job.updatedAt} END))`.mapWith(
          job.lastClaimedAt,
        ),
      })
      .from(job)
      .where(inArray(job.runId, ids))
      .groupBy(job.runId),
    getDb(db)
      .select({
        id: run.id,
        status: run.status,
        failureCode: run.failureCode,
        startedAt: run.startedAt,
      })
      .from(run)
      .where(inArray(run.id, ids)),
  ]);
  const lastById = new Map(
    progress.map((row) => [row.runId, row.last ?? null]),
  );
  const ownerById = new Map(owners.map((row) => [row.id, row]));
  return runs.map((entry) => {
    const counts: RunRollup["counts"] = {};
    let live = 0;
    for (const tally of tallies) {
      if (tally.runId !== entry.id) continue;
      const parsed = jobWaitingOnReason.safeParse(tally.reason);
      if (!parsed.success) continue;
      counts[parsed.data] = (counts[parsed.data] ?? 0) + tally.count;
      live += tally.count;
    }
    const owner = ownerById.get(entry.id);
    const last = lastById.get(entry.id) ?? null;
    const since = last ?? owner?.startedAt ?? null;
    const waitingForFunding =
      owner?.failureCode === "execution_limit" &&
      (owner.status === runStatus.enum.paused_auth ||
        owner.status === runStatus.enum.needs_review);
    return {
      runId: runShortcode.parse(entry.shortcode),
      counts,
      waitingForFunding,
      lastProgressAt: iso(last),
      stalled:
        live > 0 &&
        !waitingForFunding &&
        !counts.leased &&
        since !== null &&
        now.getTime() - since.getTime() >= RUN_STALL_MS,
      stallMinutes: RUN_STALL_MS / 60_000,
    };
  });
}
