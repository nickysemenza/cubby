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
import { imageLeasesByExecutor } from "~/server/generic/jobs/repo/image-leases";
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

/**
 * Each listed Run's demand as (run_id, job_id) pairs: Jobs it owns by
 * `runId`, and AI evaluation Jobs, which carry no `runId` because one
 * evaluation can serve several Runs, for evaluations the Run owns or still
 * requests. A withdrawn (cancelled) request no longer counts, for its owner
 * either. UNION keeps one pair however many routes reach a Job.
 */
export function runDemandPairs(runIds: readonly RunId[]): SQL {
  const runs = sql.join(
    runIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`(
    SELECT "Job"."runId" AS run_id, "Job".id AS job_id FROM "Job"
      WHERE "Job"."runId" IN (${runs})
    UNION
    SELECT e."runId", j.id FROM "AiEvaluation" e
      JOIN "Job" j ON j.key = 'ai-evaluation:' || e.id::text
      WHERE e."runId" IN (${runs}) AND NOT EXISTS (
        SELECT 1 FROM "AiEvaluationRequest" w WHERE w."evaluationId" = e.id
          AND w."runId" = e."runId" AND w."cancelledAt" IS NOT NULL)
    UNION
    SELECT r."runId", j.id FROM "AiEvaluationRequest" r
      JOIN "Job" j ON j.key = 'ai-evaluation:' || r."evaluationId"::text
      WHERE r."runId" IN (${runs}) AND r."cancelledAt" IS NULL
  )`;
}

/** One Run's demand as a predicate on "Job". */
export const runDemandWhere = (runId: RunId) =>
  sql`"Job".id IN (SELECT d.job_id FROM ${runDemandPairs([runId])} d)`;

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
    runId ? runDemandWhere(runId) : undefined,
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
  const [tallies, rows, leases] = await Promise.all([
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
    imageLeasesByExecutor(db, where),
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
    leases,
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
  const reason = jobWaitingOnReasonSql(undefined, now);
  const at = sql`${now.toISOString()}::timestamp`;
  const demand = runDemandPairs(ids);
  const [tallies, progress, owners] = await Promise.all([
    getDb(db).execute<{
      runId: RunId;
      reason: JobWaitingOnReason | null;
      expired: boolean;
      count: number;
    }>(sql`SELECT d.run_id AS "runId", ${reason} AS reason,
        ("Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" <= ${at}) AS expired,
        count(*)::int AS count
      FROM ${demand} d JOIN "Job" ON "Job".id = d.job_id
      WHERE "Job".state IN (${sql.join(
        LIVE_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})
      GROUP BY 1, 2, 3`),
    // Epoch milliseconds: the driver would read a zoneless timestamp as local time.
    getDb(db).execute<{ runId: RunId; last: number | null }>(sql`
      SELECT d.run_id AS "runId", (extract(epoch FROM max(greatest("Job"."lastClaimedAt",
          CASE WHEN "Job".state = ${jobState.enum.completed} THEN "Job"."updatedAt" END))) * 1000)::float8 AS last
      FROM ${demand} d JOIN "Job" ON "Job".id = d.job_id GROUP BY 1`),
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
    progress.rows.map((row) => [
      row.runId,
      row.last === null ? null : new Date(row.last),
    ]),
  );
  const ownerById = new Map(owners.map((row) => [row.id, row]));
  return runs.map((entry) => {
    const counts: RunRollup["counts"] = {};
    let live = 0;
    let expiredLeases = 0;
    for (const tally of tallies.rows) {
      if (tally.runId !== entry.id) continue;
      const parsed = jobWaitingOnReason.safeParse(tally.reason);
      if (!parsed.success) continue;
      live += tally.count;
      // A lapsed lease is no progress in flight; only live leases hold off `stalled`.
      if (tally.expired) expiredLeases += tally.count;
      else counts[parsed.data] = (counts[parsed.data] ?? 0) + tally.count;
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
      expiredLeases,
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
