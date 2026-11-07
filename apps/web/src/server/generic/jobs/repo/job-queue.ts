import { runShortcode, type RunId } from "@cubby/schemas/identifiers";
import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobState,
  jobWaitingOnReason,
  type JobLane,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import {
  runStatus,
  ATTENTION_RUN_PURPOSES,
  RUN_PURPOSE_LABEL,
  isMemberStartedRun,
} from "@cubby/schemas/run-fields";
import type { WorkStuckItem } from "@cubby/schemas/work-status";
import { countLabel } from "@cubby/shared/pluralize";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { and, inArray, notInArray, or, type SQL, sql } from "drizzle-orm";

import type {
  JobFacts,
  JobSetFilter,
  RunRollup,
} from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import { job } from "~/server/db/retained-tables";
import { run } from "~/server/db/schema";
import { imageJobWaitingOnReasonSql } from "~/server/domains/image-processing/repo/image-job-state";
import {
  memberStoppedRunPredicate,
  settledAiRunPredicate,
  retiredRunPredicate,
  historicalRoutineRunPredicate,
} from "~/server/domains/run/repo/work-attention";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  JOB_KIND_POLICY,
  jobKindPolicy,
} from "~/server/generic/jobs/kind-policy";
import { runHasLiveJobs } from "~/server/generic/jobs/repo/job-reads";
import { retryJobsNow } from "~/server/generic/jobs/repo/operator";
import { type JobRow } from "~/server/generic/jobs/repo/queue";
import {
  jobWaitingOnReasonSql,
  loadJobWaitingOn,
} from "~/server/generic/jobs/repo/waiting-on";

/** A Run whose live Jobs saw no claim or completion for this long is stalled. */
const RUN_STALL_MS = 15 * 60_000;

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

/** Each listed Run's demand as (run_id, job_id) pairs from its owned Jobs. */
function runDemandPairs(runIds: readonly RunId[] | SQL): SQL {
  const runs = Array.isArray(runIds)
    ? sql.join(
        runIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )
    : runIds;
  return sql`(
    SELECT "Job"."runId" AS run_id, "Job".id AS job_id FROM "Job"
      WHERE "Job"."runId" IN (${runs})
  )`;
}

/** The list filter/sort and the rollup share the same demand and stall test. */
export function runStalledSql(now = new Date()): SQL<boolean> {
  const demand = runDemandPairs(sql`SELECT ${outer(run.id)}`);
  const at = sql`${now.toISOString()}::timestamp`;
  // A Run's open image rows are demand too, on their own execution columns.
  const images = sql`"ImageProcessingJob" p WHERE p."runId" = ${outer(run.id)}`;
  return sql<boolean>`(
    NOT (${run.failureCode} IS NOT DISTINCT FROM 'execution_limit' AND ${run.status} IN (${runStatus.enum.paused_auth}, ${runStatus.enum.needs_review}))
    AND (${runHasLiveJobs(outer(run.id))}
      OR EXISTS (SELECT 1 FROM ${images} AND p.state = ${imageProcessingJobState.enum.pending}))
    AND NOT EXISTS (SELECT 1 FROM ${demand} d JOIN "Job" j ON j.id = d.job_id
      WHERE j.state = ${jobState.enum.running} AND j."leaseExpiresAt" > ${at})
    AND NOT EXISTS (SELECT 1 FROM ${images} AND p.state = ${imageProcessingJobState.enum.pending} AND p."leaseUntil" > ${at})
    AND coalesce(greatest(
      (SELECT max(greatest(j."lastClaimedAt", CASE WHEN j.state = ${jobState.enum.completed} THEN j."updatedAt" END))
        FROM ${demand} d JOIN "Job" j ON j.id = d.job_id),
      (SELECT max(greatest(p."dispatchedAt", p."completedAt")) FROM ${images})
    ), ${run.startedAt}) <= ${at} - ${RUN_STALL_MS} * interval '1 millisecond'
  )`;
}

/** Member stops and retirement stay in history; successors take over stopped work. */
export function runNeedsAttentionSql(): SQL<boolean> {
  const successor = related(
    run,
    (next) => sql`${next.predecessorRunId} = ${outer(run.id)}`,
  ).exists();
  return sql<boolean>`(NOT ${memberStoppedRunPredicate(sql`${run.failureCode}`)} AND NOT ${retiredRunPredicate(sql`${run.retiredAt}`)}
    AND (${runStalledSql()} OR (${run.status} IN (${runStatus.enum.paused},${runStatus.enum.paused_auth},${runStatus.enum.needs_review},${runStatus.enum.failed},${runStatus.enum.dispatch_failed}) AND NOT ${successor} AND NOT ${historicalRoutineRunPredicate({ id: outer(run.id), purpose: sql`${run.purpose}`, status: sql`${run.status}`, trigger: sql`${run.trigger}`, endedAt: sql`${run.endedAt}`, failureCode: sql`${run.failureCode}` })} AND NOT ${settledAiRunPredicate({ id: outer(run.id), purpose: sql`${run.purpose}`, status: sql`${run.status}`, failureCode: sql`${run.failureCode}` })})))`;
}

/** One Run's demand as a predicate on "Job". */
export const runDemandWhere = (runId: RunId) =>
  sql`"Job".id IN (SELECT d.job_id FROM ${runDemandPairs([runId])} d)`;

/** The SQL predicate of a filtered Job set, shared by the list, counts and Retry now. */
function jobSetWhere(
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
    filter.needsAttention === undefined
      ? undefined
      : sql`(${job.state} = ${jobState.enum.failed} OR ${job.attempts} >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}) = ${filter.needsAttention}`,
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
    loadJobWaitingOn(rows, now),
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
      waitUntil: row.waitReason ? iso(row.availableAt) : null,
      availableAt: row.availableAt.toISOString(),
      leaseExpiresAt: iso(row.leaseExpiresAt),
      error: row.error === null ? null : scrubErrorMessage(row.error),
      cursor: row.cursor,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lane: jobKindPolicy(row.kind).lane,
      waitingOn,
      runId: runCode ? runShortcode.parse(runCode) : null,
    };
  });
}

/** Counts by lane and reason for the whole set, and one page of its Jobs. */
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
  const runList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [tallies, imageTallies, progress, imageProgress, owners] =
    await Promise.all([
      getDb(db).execute<{
        runId: RunId;
        reason: JobWaitingOnReason | null;
        expired: boolean;
        count: number;
      }>(
        sql`SELECT d.run_id AS "runId", ${reason} AS reason,
        ("Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" <= ${at}) AS expired,
        count(*)::int AS count
      FROM ${demand} d JOIN "Job" ON "Job".id = d.job_id
      WHERE "Job".state IN (${sql.join(
        LIVE_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})
      GROUP BY 1, 2, 3`,
        "objects",
      ),
      getDb(db).execute<{
        runId: RunId;
        reason: JobWaitingOnReason | null;
        expired: boolean;
        count: number;
      }>(
        sql`SELECT p."runId" AS "runId", ${imageJobWaitingOnReasonSql("p", now)} AS reason,
        coalesce(p."leaseUntil" <= ${at}, false) AS expired,
        count(*)::int AS count
      FROM "ImageProcessingJob" p
      WHERE p."runId" IN (${runList}) AND p.state = ${imageProcessingJobState.enum.pending}
      GROUP BY 1, 2, 3`,
        "objects",
      ),
      // Epoch milliseconds: the driver would read a zoneless timestamp as local time.
      getDb(db).execute<{ runId: RunId; last: number | null }>(
        sql`
      SELECT d.run_id AS "runId", (extract(epoch FROM max(greatest("Job"."lastClaimedAt",
          CASE WHEN "Job".state = ${jobState.enum.completed} THEN "Job"."updatedAt" END))) * 1000)::float8 AS last
      FROM ${demand} d JOIN "Job" ON "Job".id = d.job_id GROUP BY 1`,
        "objects",
      ),
      getDb(db).execute<{ runId: RunId; last: number | null }>(
        sql`
      SELECT p."runId" AS "runId", (extract(epoch FROM max(greatest(p."dispatchedAt", p."completedAt"))) * 1000)::float8 AS last
      FROM "ImageProcessingJob" p WHERE p."runId" IN (${runList}) GROUP BY 1`,
        "objects",
      ),
      getDb(db)
        .select({
          id: run.id,
          status: run.status,
          failureCode: run.failureCode,
          startedAt: run.startedAt,
          stalled: runStalledSql(now),
        })
        .from(run)
        .where(inArray(run.id, ids)),
    ]);
  const lastById = new Map<RunId, Date>();
  for (const row of [...progress, ...imageProgress]) {
    const known = lastById.get(row.runId);
    if (row.last !== null && (!known || known.getTime() < row.last))
      lastById.set(row.runId, new Date(row.last));
  }
  const ownerById = new Map(owners.map((row) => [row.id, row]));
  return runs.map((entry) => {
    const counts: RunRollup["counts"] = {};
    let expiredLeases = 0;
    for (const tally of [...tallies, ...imageTallies]) {
      if (tally.runId !== entry.id) continue;
      const parsed = jobWaitingOnReason.safeParse(tally.reason);
      if (!parsed.success) continue;
      // A lapsed lease is no progress in flight; only live leases hold off `stalled`.
      if (tally.expired) expiredLeases += tally.count;
      else counts[parsed.data] = (counts[parsed.data] ?? 0) + tally.count;
    }
    const owner = ownerById.get(entry.id);
    const last = lastById.get(entry.id) ?? null;
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
      stalled: owner?.stalled ?? false,
      stallMinutes: RUN_STALL_MS / 60_000,
    };
  });
}

const FAILURE_LOOKBACK_DAYS = 7;
const REPEATED_RUN_FAILURES = 3;
const MINUTE_MS = 60_000;
const stamp = (value: Date) => sql`${value.toISOString()}::timestamp`;
const utc = (value: string | null) =>
  value === null ? null : new Date(`${value}Z`);
const runLink = (code: string): WorkStuckItem["action"] => ({
  type: "link",
  label: "Open Run",
  href: `/runs/${code}`,
});
const formatStuckAge = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 90) return countLabel(minutes, "minute");
  if (minutes < 48 * 60) return countLabel(Math.round(minutes / 60), "hour");
  return countLabel(Math.round(minutes / (24 * 60)), "day");
};
/**
 * Runs a member started or reviews that stopped. Stalled Runs are listed one by
 * one. Failures collapse to each purpose's latest and clear when a later Run of
 * that purpose completes. A member's own failed Run shows at once; a scheduled
 * or discovered Run retries on its own, so it counts only once it keeps failing.
 * Paused Runs are a member's choice.
 */
export async function readStoppedRuns(db: Database, now: Date) {
  const purposes = sql.join(
    ATTENTION_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
    sql`, `,
  );
  const columns = {
    id: run.id,
    shortcode: run.shortcode,
    purpose: run.purpose,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    failureCode: run.failureCode,
    dispatchError: run.dispatchError,
  };
  const stalled = await getDb(db)
    .select(columns)
    .from(run)
    .where(
      sql`${notDeleted(run)} AND ${run.purpose} IN (${purposes})
        AND ${run.status} = ${runStatus.enum.running} AND ${runStalledSql(now)}`,
    )
    .orderBy(sql`${run.startedAt} DESC`)
    .limit(8);
  const failed = await getDb(db)
    .select(columns)
    .from(run)
    .where(
      sql`${notDeleted(run)} AND ${run.purpose} IN (${purposes})
        AND ${run.status} IN (${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed})
        AND ${run.endedAt} > ${stamp(new Date(now.getTime() - FAILURE_LOOKBACK_DAYS * 24 * 60 * MINUTE_MS))}
        AND NOT EXISTS (SELECT 1 FROM "Run" next
          WHERE next."predecessorRunId" = ${run.id} AND ${notDeleted("next")})`,
    )
    .orderBy(sql`${run.endedAt} DESC`);
  const failedPurposes = [...new Set(failed.map((row) => row.purpose))];
  const completed = failedPurposes.length
    ? await getDb(db)
        .select({
          purpose: run.purpose,
          endedAt: sql<string>`max(${run.endedAt})`,
        })
        .from(run)
        .where(
          sql`${run.status} = ${runStatus.enum.completed} AND ${run.purpose} IN (${sql.join(
            failedPurposes.map((purpose) => sql`${purpose}`),
            sql`, `,
          )})`,
        )
        .groupBy(run.purpose)
    : [];
  const lastCompleted = new Map(
    completed.map((row) => [row.purpose, utc(row.endedAt)]),
  );
  const open = failedPurposes.flatMap((purpose) => {
    const later = lastCompleted.get(purpose);
    const failures = failed.filter(
      (row) =>
        row.purpose === purpose &&
        row.endedAt &&
        (!later || row.endedAt > later),
    );
    const newest = failures[0];
    if (!newest) return [];
    return isMemberStartedRun(newest) ||
      failures.length >= REPEATED_RUN_FAILURES
      ? [{ row: newest, failures: failures.length }]
      : [];
  });
  const rollups = stalled.length ? await readRunRollups(db, stalled, now) : [];
  const progress = new Map<string, string | null>(
    rollups.map((rollup) => [rollup.runId, rollup.lastProgressAt]),
  );
  return [
    ...stalled.map((row): WorkStuckItem => {
      const lastProgress = progress.get(row.shortcode);
      const since = lastProgress ? new Date(lastProgress) : row.startedAt;
      return {
        key: `run:${row.shortcode}`,
        title: `${RUN_PURPOSE_LABEL[row.purpose] ?? row.purpose} Run stopped`,
        body: `${row.shortcode} has made no progress for ${formatStuckAge(now.getTime() - since.getTime())}.`,
        since: since.toISOString(),
        action: runLink(row.shortcode),
        diagnostic: row.dispatchError ?? row.failureCode,
      };
    }),
    ...open.map(({ row, failures }): WorkStuckItem => {
      const since = row.endedAt ?? row.startedAt;
      const label = RUN_PURPOSE_LABEL[row.purpose] ?? row.purpose;
      return {
        key: `run:${row.shortcode}`,
        title: failures > 1 ? `${label} keeps failing` : `${label} Run failed`,
        body:
          failures > 1
            ? `The last ${failures} Runs failed, most recently ${row.shortcode} ${formatStuckAge(now.getTime() - since.getTime())} ago.`
            : `${row.shortcode} failed ${formatStuckAge(now.getTime() - since.getTime())} ago.`,
        since: since.toISOString(),
        action: runLink(row.shortcode),
        diagnostic: row.dispatchError ?? row.failureCode,
      };
    }),
  ];
}
