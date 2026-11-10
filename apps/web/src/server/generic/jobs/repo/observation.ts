import {
  aiEvaluationState,
  aiExecutionKind,
} from "@cubby/schemas/ai-evaluation";
import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { runShortcode } from "@cubby/schemas/identifiers";
import {
  imageProcessingAttemptState,
  imageProcessingJobState,
} from "@cubby/schemas/image-processing";
import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobKindDeclaration,
} from "@cubby/schemas/job";
import {
  jobExecution,
  jobState,
  workQueueWaitReason,
} from "@cubby/schemas/job";
import type {
  AiEvaluationBacklog,
  JobExecution,
  WorkActivity,
  WorkQueueUnit,
  WorkQueueWait,
} from "@cubby/schemas/job";
import { RUN_PURPOSE_LABEL, runPurpose } from "@cubby/schemas/run-fields";
import type { WorkStuckItem } from "@cubby/schemas/work-status";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { hasEvaluationRetryReceipt as retried } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import type { Database } from "~/server/db/database";
import { derivedRebuild } from "~/server/db/derived-rebuild-schema";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { job, run } from "~/server/db/retained-tables";
import { appleFailureCoveredByCloudDescriptionSql } from "~/server/domains/image-processing/repo/processor-policy";
import { INTERNAL_JOB_KINDS } from "~/server/generic/jobs/kind-policy";
import {
  DRAIN_RECORD_KIND,
  jobDue,
  type DrainDue,
} from "~/server/generic/jobs/repo/queue";

/** Completions and failures are counted over these recent windows. */
const RECENT_MINUTES = {
  pace: 5,
  completed: 15,
  failed: 60,
  outcome: 60,
} as const;
/** Blocked evaluations are terminal history; only recent ones are a backlog. */
const BLOCKED_DAYS = 7;
/** Wait groups named per Job kind, largest first. */
const WAIT_GROUPS = 3;
/** Active Runs named per stream, newest first. */
const STREAM_RUNS = 3;

type StreamRow = {
  kind: string;
  running: number;
  due: number;
  backingOff: number;
  scheduled: number;
  paused: number;
  completedPace: number;
  completed: number;
  failed: number;
  lastCompletedAt: string | null;
  lastFailedAt?: string | null;
  diagnostic?: string | null;
  oldestDueAt: string | null;
  /** Job kinds only: the start of the oldest run of deferrals still re-polling. */
  deferringSince?: string | null;
  runs: string[] | null;
};

/**
 * Image work owns its execution on `ImageProcessingJob`: one stream per lane, with
 * failures counted from its attempts. Only open rows and rows finished within the
 * failure window are read.
 */
async function readImageStreams(db: Database, now: Date): Promise<StreamRow[]> {
  const at = sql`${now.toISOString()}::timestamp`;
  const since = (minutes: number) =>
    sql`${at} - ${minutes} * interval '1 minute'`;
  const pending = imageProcessingJobState.enum.pending;
  const finished = sql`p.state IN (${imageProcessingJobState.enum.ready}, ${imageProcessingJobState.enum.skipped})`;
  const claimable = sql`p.state = ${pending} AND coalesce(p."leaseUntil", p."runAt") <= ${at}`;
  const later = sql`p.state = ${pending} AND p."leaseUntil" IS NULL AND p."runAt" > ${at}`;
  const rows = await getDb(db).execute<StreamRow>(
    sql`
    SELECT 'image.' || p.lane AS kind,
      count(*) FILTER (WHERE p.state = ${pending} AND p."leaseUntil" > ${at})::int AS "running",
      count(*) FILTER (WHERE ${claimable})::int AS "due",
      count(*) FILTER (WHERE ${later} AND p.failures > 0)::int AS "backingOff",
      count(*) FILTER (WHERE ${later} AND p.failures = 0)::int AS "scheduled",
      0 AS "paused",
      count(*) FILTER (WHERE ${finished} AND p."completedAt" > ${since(RECENT_MINUTES.pace)})::int AS "completedPace",
      count(*) FILTER (WHERE ${finished} AND p."completedAt" > ${since(RECENT_MINUTES.completed)})::int AS "completed",
      (SELECT count(*)::int FROM "ImageProcessingAttempt" a
        JOIN "ImageProcessingJob" job ON job.id = a."jobId"
        WHERE job.lane = p.lane AND a.state = ${imageProcessingAttemptState.enum.failed}
          AND a."completedAt" > ${since(RECENT_MINUTES.failed)}) AS "failed",
      max(p."completedAt") FILTER (WHERE ${finished}) AS "lastCompletedAt",
      min(coalesce(p."leaseUntil", p."runAt")) FILTER (WHERE ${claimable}) AS "oldestDueAt",
      ARRAY(
        SELECT r.shortcode FROM "ImageProcessingJob" stream
        JOIN "Run" r ON r.id = stream."runId"
        WHERE stream.lane = p.lane AND stream.state = ${pending} AND ${notDeleted("r")}
          AND r.status IN (${sql.join(
            ACTIVE_RUN_STATUSES.map((status) => sql`${status}`),
            sql`, `,
          )})
        GROUP BY r.id ORDER BY r."createdAt" DESC, r.id LIMIT ${STREAM_RUNS}
      ) AS "runs"
    FROM "ImageProcessingJob" p
    WHERE p.state = ${pending} OR p."completedAt" > ${since(RECENT_MINUTES.failed)}
      OR EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a
        WHERE a."jobId" = p.id AND a.state = ${imageProcessingAttemptState.enum.failed}
          AND a."completedAt" > ${since(RECENT_MINUTES.failed)})
    GROUP BY p.lane`,
    "objects",
  );
  return rows;
}

/** Search embeddings, held on their documents and retired artifacts. */
async function readEmbeddingStreams(
  db: Database,
  now: Date,
): Promise<StreamRow[]> {
  const at = sql`${now.toISOString()}::timestamp`;
  const since = (minutes: number) =>
    sql`${at} - ${minutes} * interval '1 minute'`;
  const empty = { paused: 0, runs: null };
  const rows = await getDb(db).execute<
    Omit<StreamRow, "paused" | "runs" | "failed" | "kind"> & {
      cleanupDue: number;
      cleanupLater: number;
    }
  >(
    sql`
    WITH owed AS MATERIALIZED (
      SELECT "embeddingDueAt" AS due, "embeddingAttempts" AS attempts,
        coalesce("embeddingLeaseUntil" > ${at}, false) AS leased
      FROM "SearchDocument"
      WHERE "embeddingDueAt" IS NOT NULL AND ${notDeleted("SearchDocument")}
    ), indexed AS MATERIALIZED (
      SELECT "indexedAt" AS at FROM "EntityEmbedding"
      WHERE "indexedAt" > ${since(RECENT_MINUTES.failed)}
    ), retired AS MATERIALIZED (
      SELECT "deletionRetryAt" AS retry FROM "EntityEmbedding"
      WHERE "deletionId" IS NULL AND "artifactState" <> ${embeddingArtifactState.enum.selected}
        AND ("deletedAt" IS NOT NULL OR "artifactState" IN (${embeddingArtifactState.enum.retired}, ${embeddingArtifactState.enum.failed}))
    )
    SELECT (SELECT count(*)::int FROM owed WHERE leased) AS running,
      (SELECT count(*)::int FROM owed WHERE due <= ${at} AND NOT leased) AS due,
      (SELECT count(*)::int FROM owed WHERE due > ${at} AND NOT leased AND attempts > 0) AS "backingOff",
      (SELECT count(*)::int FROM owed WHERE due > ${at} AND NOT leased AND attempts = 0) AS scheduled,
      (SELECT count(*)::int FROM indexed WHERE at > ${since(RECENT_MINUTES.pace)}) AS "completedPace",
      (SELECT count(*)::int FROM indexed WHERE at > ${since(RECENT_MINUTES.completed)}) AS completed,
      (SELECT max(at) FROM indexed) AS "lastCompletedAt",
      (SELECT min(due) FROM owed WHERE due <= ${at} AND NOT leased) AS "oldestDueAt",
      (SELECT count(*)::int FROM retired WHERE coalesce(retry <= ${at}, true)) AS "cleanupDue",
      (SELECT count(*)::int FROM retired WHERE retry > ${at}) AS "cleanupLater"`,
    "objects",
  );
  const row = rows[0];
  if (!row) return [];
  const { cleanupDue, cleanupLater, ...refresh } = row;
  return [
    { ...refresh, ...empty, kind: "embedding.refresh", failed: 0 },
    {
      ...empty,
      kind: "embedding.cleanup",
      running: 0,
      due: cleanupDue,
      backingOff: cleanupLater,
      scheduled: 0,
      completedPace: 0,
      completed: 0,
      failed: 0,
      lastCompletedAt: null,
      oldestDueAt: null,
    },
  ];
}

/** AI evaluations, held on their own rows: one stream per feature. */
async function readAiEvaluationStreams(
  db: Database,
  now: Date,
): Promise<StreamRow[]> {
  const at = sql`${now.toISOString()}::timestamp`;
  const since = (minutes: number) =>
    sql`${at} - ${minutes} * interval '1 minute'`;
  const owed = sql`e."runAt" IS NOT NULL AND e.state IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.result_ready})`;
  const held = sql`e."leaseUntil" > ${at}`;
  const later = sql`${owed} AND NOT coalesce(${held}, false) AND e."runAt" > ${at}`;
  const claimable = sql`${owed} AND NOT coalesce(${held}, false) AND e."runAt" <= ${at}`;
  const rows = await getDb(db).execute<StreamRow>(
    sql`
    SELECT 'ai.evaluation:' || e.feature AS kind,
      count(*) FILTER (WHERE ${held})::int AS "running",
      count(*) FILTER (WHERE ${claimable})::int AS "due",
      count(*) FILTER (WHERE ${later} AND e.attempts > 0)::int AS "backingOff",
      count(*) FILTER (WHERE ${later} AND e.attempts = 0)::int AS "scheduled",
      0 AS "paused",
      count(*) FILTER (WHERE e.state = ${aiEvaluationState.enum.completed} AND e."updatedAt" > ${since(RECENT_MINUTES.pace)})::int AS "completedPace",
      count(*) FILTER (WHERE e.state = ${aiEvaluationState.enum.completed} AND e."updatedAt" > ${since(RECENT_MINUTES.completed)})::int AS "completed",
      count(*) FILTER (WHERE e.state = ${aiEvaluationState.enum.failed} AND e."updatedAt" > ${since(RECENT_MINUTES.failed)})::int AS "failed",
      -- Evidence invalidation finishes owed work without publishing a value.
      max(e."updatedAt") FILTER (WHERE e.state IN (${aiEvaluationState.enum.completed}, ${aiEvaluationState.enum.obsolete})) AS "lastCompletedAt",
      min(e."runAt") FILTER (WHERE ${claimable}) AS "oldestDueAt",
      ARRAY(
        SELECT r.shortcode FROM "AiEvaluation" stream
        JOIN "Run" r ON r.id = stream."runId"
        WHERE stream.feature = e.feature AND stream."runAt" IS NOT NULL AND ${notDeleted("r")}
          AND r.status IN (${sql.join(
            ACTIVE_RUN_STATUSES.map((status) => sql`${status}`),
            sql`, `,
          )})
        GROUP BY r.id ORDER BY r."createdAt" DESC, r.id LIMIT ${STREAM_RUNS}
      ) AS "runs"
    FROM "AiEvaluation" e
    WHERE ${owed} OR e."updatedAt" > ${since(RECENT_MINUTES.failed)}
    GROUP BY e.feature`,
    "objects",
  );
  return rows;
}

/** Member wording for drain units that have no stream of their own. */
const DRAIN_UNIT_LABEL = new Map<string, string>([
  ["derived-rebuild", "Totals and search rebuild"],
  ["email-purchase-discovery", "Email purchase links"],
  ["field-automation:events", "Field suggestions after changes"],
  ["field-automation:policy", "Field suggestions after a policy update"],
  ["reconcile", "Stopped Run cleanup"],
]);

/** The stream that counts a drain unit's items, when it has one. */
const drainStreamKind = (unit: string) =>
  unit.startsWith("ai-evaluation:")
    ? `ai.evaluation:${unit.slice("ai-evaluation:".length)}`
    : unit;
const streamDrainUnit = (kind: string) =>
  kind.startsWith("ai.evaluation:")
    ? `ai-evaluation:${kind.slice("ai.evaluation:".length)}`
    : kind.startsWith("embedding.") || kind === "image.cloud"
      ? kind
      : null;

/** A drain unit in member words: its own label, else its stream's, else its stored name. */
const drainUnitLabel = (unit: string) =>
  DRAIN_UNIT_LABEL.get(unit) ?? kindLabel(drainStreamKind(unit));

/** A drain unit's record row: its rotation stamp, latest page and failing streak. */
type DrainRecord = {
  unit: string;
  lastClaimedAt: Date | null;
  lastExecution: JobExecution | null;
  error: string | null;
  failingSince: Date | null;
};

type QueueJobRow = Pick<
  WorkQueueUnit,
  "unit" | "claimed" | "succeeded" | "deferred" | "failed" | "leased"
> & {
  expiredLeases: number;
  lastClaimedAt: string | null;
  oldestDueAt: string | null;
};

/**
 * What the queue did per Job kind and drain unit. `Job.lastExecution` keeps
 * only each row's latest execution, so outcomes count rows, never executions.
 * It reads live Jobs, Jobs updated within the window and the drain record
 * rows, so its cost follows current work. `drains` are the registered drains'
 * `due` rows: a unit one reports is owed now, whatever its record row says.
 */
async function readQueue(db: Database, now: Date, drains: readonly DrainDue[]) {
  const at = sql`${now.toISOString()}::timestamp`;
  const since = sql`${at} - ${RECENT_MINUTES.outcome} * interval '1 minute'`;
  const live = sql`"Job".state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running}, ${jobState.enum.paused})`;
  const waiting = sql`${jobDue(now)} AND NOT ("Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" > ${at})`;
  const outcome = (value: JobExecution["outcome"]) =>
    sql`count(*) FILTER (WHERE "Job".recent AND "Job"."lastExecution"->>'outcome' = ${value})::int`;
  const kinds = await getDb(db).execute<QueueJobRow>(sql`
    WITH queue_jobs AS MATERIALIZED (
      SELECT "Job".*,
        coalesce(("Job"."lastExecution"->>'finishedAt')::timestamptz
          > ${now.toISOString()}::timestamptz - ${RECENT_MINUTES.outcome} * interval '1 minute', false) AS recent
      FROM "Job"
      WHERE (${live} OR "Job"."updatedAt" > ${since}) AND "Job".kind <> ${DRAIN_RECORD_KIND}
    )
    SELECT "Job".kind AS unit,
      count(*) FILTER (WHERE "Job"."lastClaimedAt" > ${since})::int AS claimed,
      ${outcome("succeeded")} AS succeeded,
      ${outcome("deferred")} AS deferred,
      ${outcome("failed")} AS failed,
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" > ${at})::int AS leased,
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" <= ${at})::int AS "expiredLeases",
      max("Job"."lastClaimedAt") AS "lastClaimedAt",
      min(CASE WHEN "Job".state = ${jobState.enum.running} THEN "Job"."leaseExpiresAt" ELSE "Job"."availableAt" END)
        FILTER (WHERE ${waiting}) AS "oldestDueAt"
    FROM queue_jobs "Job"
    GROUP BY "Job".kind`);
  // Claim order within a kind: the longest due first, each priority point a
  // minute's head start (`dueUnits`), so `runs` names the head of the line.
  const waits = await getDb(db).execute<
    Omit<WorkQueueWait, "runIds" | "summary"> & {
      unit: string;
      runs: string[] | null;
    }
  >(sql`
    SELECT "Job".kind AS unit,
      coalesce("Job"."waitReason", CASE WHEN "Job".state = ${jobState.enum.retry_wait}
        THEN ${workQueueWaitReason.enum.retry}::text ELSE ${workQueueWaitReason.enum.turn}::text END) AS reason,
      r.purpose AS "runPurpose",
      count(*)::int AS count,
      count(*) FILTER (WHERE "Job"."lastExecution"->>'outcome' = ${jobExecution.shape.outcome.enum.deferred})::int AS deferred,
      (array_agg(r.shortcode ORDER BY "Job"."availableAt" - "Job".priority * interval '1 minute', "Job".id)
        FILTER (WHERE r.shortcode IS NOT NULL))[1:12] AS runs
    FROM "Job" LEFT JOIN "Run" r ON r.id = "Job"."runId"
    WHERE "Job".state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait})
      AND "Job".kind <> ${DRAIN_RECORD_KIND}
    GROUP BY 1, 2, 3
    ORDER BY count(*) DESC, 1, 2, 3`);
  const records = await getDb(db)
    .select({
      key: job.key,
      lastClaimedAt: job.lastClaimedAt,
      lastExecution: job.lastExecution,
      error: job.error,
      failingSince: job.failingSince,
    })
    .from(job)
    .where(eq(job.kind, DRAIN_RECORD_KIND));
  const owed = drains.length
    ? await getDb(db).execute<{ unit: string; since: string }>(sql`
        SELECT reported.unit, min(reported.since) AS since FROM (${sql.join(
          drains.map(({ due }) => sql`(SELECT unit, since FROM (${due}) due)`),
          sql` UNION ALL `,
        )}) reported GROUP BY reported.unit`)
    : { rows: [] };
  return {
    kinds: kinds.rows,
    waits: waits.rows,
    owed: new Map(
      owed.rows.map((row) => [row.unit, new Date(`${row.since}Z`)]),
    ),
    drains: records.map(({ key, ...record }): DrainRecord => ({
      ...record,
      unit: key.slice("drain:".length),
    })),
  };
}

/**
 * Owed and recently blocked AI evaluations by feature and state. It also
 * reports, per feature, answers that are paid for, owed and not published: a
 * `result_ready` row no page holds that is due, or that waits out a failed
 * publication's backoff. A row parked (`runAt` null), postponed, or held by a
 * funding or provider wait (`waitCause`) until a later `runAt` is waiting on
 * purpose and is not counted. A row counts from its failing streak's start,
 * else from when it fell due.
 */
async function readAiEvaluationBacklog(db: Database, now: Date) {
  const at = sql`${now.toISOString()}::timestamp`;
  const { queued, result_ready, blocked } = aiEvaluationState.enum;
  const unpublished = sql`e.state = ${result_ready} AND e."runAt" IS NOT NULL
    AND NOT coalesce(e."leaseUntil" > ${at}, false)
    AND (e."runAt" <= ${at} OR (e."failingSince" IS NOT NULL AND e."waitCause" IS NULL))`;
  const rows = await getDb(db).execute<{
    feature: string;
    state: AiEvaluationBacklog["state"];
    count: number;
    oldestAt: string;
    errorClass: string | null;
    unpublished: number;
    unpublishedSince: string | null;
  }>(sql`
    SELECT e.feature, e.state, count(*)::int AS count, min(e."createdAt") AS "oldestAt",
      -- Stored errors are cause chains; the first cause's name is the class.
      mode() WITHIN GROUP (ORDER BY coalesce(substring(e.error from '"name":"([^"]+)"'), left(e.error, 80)))
        FILTER (WHERE e.error IS NOT NULL) AS "errorClass",
      count(*) FILTER (WHERE ${unpublished})::int AS unpublished,
      min(CASE WHEN e."waitCause" IS NULL THEN coalesce(e."failingSince", e."runAt") ELSE e."runAt" END)
        FILTER (WHERE ${unpublished}) AS "unpublishedSince"
    FROM "AiEvaluation" e
    -- Every execution kind, spelled out so the (executionKind, state) index serves the read.
    WHERE e."executionKind" IN (${sql.join(
      aiExecutionKind.options.map((kind) => sql`${kind}`),
      sql`, `,
    )})
      AND (e.state IN (${queued}, ${result_ready})
        OR (e.state = ${blocked} AND e."updatedAt" > ${at} - ${BLOCKED_DAYS} * interval '1 day'))
    GROUP BY e.feature, e.state
    ORDER BY e.feature, e.state`);
  return rows.rows;
}

const WAIT_REASON_TEXT = {
  provider_capacity: "provider capacity",
  ai_funding_window: "AI funding",
  device: "a device",
  rate_limit: "a rate limit",
  retry: "a retry",
  turn: "a turn",
} satisfies Record<WorkQueueWait["reason"], string>;

/** "115 Mail discovery Runs keep deferring on provider capacity." */
function waitSummary(
  kind: string,
  wait: Omit<WorkQueueWait, "summary" | "runIds">,
) {
  // A retained purpose missing from the manifest reads as its stored name.
  const declared = runPurpose.safeParse(wait.runPurpose);
  const purpose = declared.success
    ? RUN_PURPOSE_LABEL[declared.data]
    : wait.runPurpose;
  const noun = kind === "run.execute" ? "Run" : "Job";
  const one = wait.count === 1;
  const subject = [wait.count, purpose, one ? noun : `${noun}s`]
    .filter((part) => part !== null)
    .join(" ");
  if (wait.reason === "retry")
    return `${subject} ${one ? "is" : "are"} retrying after failures.`;
  return wait.deferred && wait.reason !== "turn"
    ? `${subject} ${one ? "keeps" : "keep"} deferring on ${WAIT_REASON_TEXT[wait.reason]}.`
    : `${subject} ${one ? "is" : "are"} waiting on ${WAIT_REASON_TEXT[wait.reason]}.`;
}

/**
 * The queue as raw text for Technical details: one line per unit that ran or
 * waits, busiest first, with its wait groups. Stored names stay verbatim.
 */
function describeQueue(activity: WorkActivity): string {
  const lines = [
    `Queue over the last ${activity.windows.outcomeMinutes} minutes, read ${activity.measuredAt}. Counts are rows by latest execution, not executions.`,
  ];
  const busiest = [...activity.queue].sort(
    (left, right) =>
      right.claimed - left.claimed || left.unit.localeCompare(right.unit),
  );
  for (const unit of busiest) {
    const page = unit.lastExecution;
    lines.push(
      [
        `${unit.unit}${unit.type === "drain" ? " (drain)" : ""}: ${unit.claimed} claimed, ${unit.succeeded} succeeded, ${unit.deferred} deferred, ${unit.failed} failed`,
        `oldest due ${unit.oldestDueAt ?? "none"}`,
        `${unit.leased} leased, ${unit.expiredLeases} expired leases`,
        `last claimed ${unit.lastClaimedAt ?? "never"}`,
        ...(page
          ? [
              `last page ${page.outcome}${page.errorClass ? ` (${page.errorClass})` : ""} at ${page.finishedAt}${
                page.items
                  ? `, items ${page.items.claimed} claimed, ${page.items.published} published, ${page.items.failed} failed`
                  : ""
              }`,
            ]
          : []),
      ].join("; "),
    );
    for (const wait of unit.waits)
      lines.push(
        `  ${wait.count} ${wait.runPurpose ?? "no Run"} waiting on ${wait.reason} (${wait.deferred} deferred)${
          wait.runIds.length ? `: ${wait.runIds.join(", ")}` : ""
        }`,
      );
  }
  for (const row of activity.evaluations)
    lines.push(
      `AiEvaluation ${row.feature} ${row.state}: ${row.count}, oldest ${row.oldestAt}${row.errorClass ? `, top error ${row.errorClass}` : ""}`,
    );
  return lines.join("\n");
}

/**
 * Live and recent work per Job kind and domain-owned stream: what runs now, what
 * waits and why, and how fast recent work finished. Internal maintenance kinds are
 * omitted. Only Jobs that are live or were claimed within the failure window are
 * read, so cost follows current work, not retained history.
 */
export async function readWorkActivity(
  db: Database,
  now = new Date(),
  drains: readonly DrainDue[] = [],
): Promise<WorkActivity> {
  return (await observeWork(db, now, drains)).activity;
}

/** The activity read plus the drain and publication facts only the status verdict uses. */
async function observeWork(
  db: Database,
  now: Date,
  drains: readonly DrainDue[],
) {
  const at = sql`${now.toISOString()}::timestamp`;
  const since = (minutes: number) =>
    sql`${at} - ${minutes} * interval '1 minute'`;
  const due = jobDue(now);
  // An expired lease is reclaimable work: it waits (since its expiry) rather
  // than running, so a stalled worker cannot make a stream read as quiet.
  const waiting = sql`${due} AND NOT ("Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" > ${at})`;
  const live = sql`"Job".state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running}, ${jobState.enum.paused})`;
  const requester = alias(run, "r");
  const rows = await getDb(db).execute<StreamRow>(sql`
    WITH activity_jobs AS MATERIALIZED (
      SELECT "Job".* FROM "Job"
      WHERE (${live} OR "Job"."updatedAt" > ${since(RECENT_MINUTES.failed)})
        ${
          INTERNAL_JOB_KINDS.length
            ? sql`AND "Job".kind NOT IN (${sql.join(
                INTERNAL_JOB_KINDS.map((kind) => sql`${kind}`),
                sql`, `,
              )})`
            : sql``
        }
    )
    SELECT "Job".kind,
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" > ${at})::int AS "running",
      count(*) FILTER (WHERE ${waiting})::int AS "due",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.retry_wait} AND "Job"."availableAt" > ${at})::int AS "backingOff",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.queued} AND "Job"."availableAt" > ${at})::int AS "scheduled",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.paused})::int AS "paused",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.completed} AND "Job"."updatedAt" > ${since(RECENT_MINUTES.pace)})::int AS "completedPace",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.completed} AND "Job"."updatedAt" > ${since(RECENT_MINUTES.completed)})::int AS "completed",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.failed} AND "Job"."updatedAt" > ${since(RECENT_MINUTES.failed)}
        AND "Job"."updatedAt" > coalesce((SELECT max(done."updatedAt") FROM activity_jobs done WHERE done.kind = "Job".kind AND done.state = ${jobState.enum.completed}), '-infinity'::timestamp))::int AS "failed",
      max("Job"."updatedAt") FILTER (WHERE "Job".state = ${jobState.enum.completed}) AS "lastCompletedAt",
      min(CASE WHEN "Job".state = ${jobState.enum.running} THEN "Job"."leaseExpiresAt" ELSE "Job"."availableAt" END)
        FILTER (WHERE ${waiting}) AS "oldestDueAt",
      -- A Job parked past the stuck window is a timer, not a poll.
      min(("Job"."lastExecution"->>'deferringSince')::timestamptz AT TIME ZONE 'UTC')
        FILTER (WHERE "Job".state = ${jobState.enum.queued}
          AND "Job"."lastExecution"->>'outcome' = ${jobExecution.shape.outcome.enum.deferred}
          AND "Job"."availableAt" <= ${at} + ${STUCK_WINDOW_MINUTES} * interval '1 minute') AS "deferringSince",
      ARRAY(
        SELECT r.shortcode FROM activity_jobs stream
        JOIN "Run" r ON r.id = stream."runId"
        WHERE stream.kind = "Job".kind AND ${notDeleted(requester)}
          AND r.status IN (${sql.join(
            ACTIVE_RUN_STATUSES.map((status) => sql`${status}`),
            sql`, `,
          )})
        GROUP BY r.id ORDER BY r."createdAt" DESC, r.id LIMIT ${STREAM_RUNS}
      ) AS "runs"
    FROM activity_jobs "Job"
    GROUP BY "Job".kind
    ORDER BY "Job".kind
  `);
  const iso = (value: string | null) =>
    value === null ? null : new Date(`${value}Z`).toISOString();
  const queue = await readQueue(db, now, drains);
  const deferring = new Map(
    rows.rows.flatMap((row) =>
      row.deferringSince
        ? [[row.kind, new Date(`${row.deferringSince}Z`)] as const]
        : [],
    ),
  );
  const evaluations = await readAiEvaluationBacklog(db, now);
  const streams = [
    ...rows.rows,
    ...(await readImageStreams(db, now)),
    ...(await readEmbeddingStreams(db, now)),
    ...(await readAiEvaluationStreams(db, now)),
  ]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map((row) => ({
      kind: row.kind,
      running: row.running,
      due: row.due,
      backingOff: row.backingOff,
      scheduled: row.scheduled,
      paused: row.paused,
      completedPerMinute: row.completedPace / RECENT_MINUTES.pace,
      completed: row.completed,
      failed: row.failed,
      lastCompletedAt: iso(row.lastCompletedAt),
      oldestDueAt: iso(row.oldestDueAt),
      runIds: (row.runs ?? []).map((code) => runShortcode.parse(code)),
    }))
    .filter(
      (stream) =>
        stream.running +
          stream.due +
          stream.backingOff +
          stream.scheduled +
          stream.paused +
          stream.completed +
          stream.failed >
        0,
    );
  const windowStart = minutesAgo(now, RECENT_MINUTES.outcome);
  const streamOf = new Map(streams.map((stream) => [stream.kind, stream]));
  const recordOf = new Map(queue.drains.map((record) => [record.unit, record]));
  // A drain unit that never ran has no record row; its stream or its drain's
  // `due` rows still name it.
  const drainUnits = new Set([
    ...recordOf.keys(),
    ...queue.owed.keys(),
    ...streams.flatMap((stream) => streamDrainUnit(stream.kind) ?? []),
  ]);
  const activity: WorkActivity = {
    rebuild: await readRebuildObservation(db),
    measuredAt: now.toISOString(),
    windows: {
      paceMinutes: RECENT_MINUTES.pace,
      completedMinutes: RECENT_MINUTES.completed,
      failedMinutes: RECENT_MINUTES.failed,
      outcomeMinutes: RECENT_MINUTES.outcome,
      blockedDays: BLOCKED_DAYS,
    },
    streams,
    queue: [
      ...queue.kinds.map((row): WorkQueueUnit => ({
        ...row,
        type: "job",
        label: kindLabel(row.unit),
        lastClaimedAt: iso(row.lastClaimedAt),
        oldestDueAt: iso(row.oldestDueAt),
        lastExecution: null,
        waits: queue.waits
          .filter((wait) => wait.unit === row.unit)
          .slice(0, WAIT_GROUPS)
          .map(({ unit: _unit, runs, ...wait }) => ({
            ...wait,
            summary: waitSummary(row.unit, wait),
            // One Run can own several waiting Jobs of a kind.
            runIds: [...new Set(runs ?? [])]
              .slice(0, STREAM_RUNS)
              .map((code) => runShortcode.parse(code)),
          })),
      })),
      ...[...drainUnits].flatMap((unit): WorkQueueUnit[] => {
        const record = recordOf.get(unit);
        const stream = streamOf.get(drainStreamKind(unit));
        const page = record?.lastExecution ?? null;
        const claimed = Boolean(
          record?.lastClaimedAt && record.lastClaimedAt > windowStart,
        );
        const owedSince = queue.owed.get(unit);
        if (!claimed && !stream && !owedSince) return [];
        const finished = (outcome: JobExecution["outcome"]) =>
          page?.outcome === outcome && new Date(page.finishedAt) > windowStart
            ? 1
            : 0;
        return [
          {
            unit,
            type: "drain",
            label: drainUnitLabel(unit),
            claimed: claimed ? 1 : 0,
            succeeded: finished("succeeded"),
            deferred: finished("deferred"),
            failed: finished("failed"),
            lastClaimedAt: record?.lastClaimedAt?.toISOString() ?? null,
            oldestDueAt:
              stream?.oldestDueAt ?? owedSince?.toISOString() ?? null,
            leased: stream?.running ?? 0,
            expiredLeases: 0,
            lastExecution: page,
            waits: [],
          },
        ];
      }),
    ].sort((left, right) => left.unit.localeCompare(right.unit)),
    evaluations: evaluations.map((row) => ({
      feature: row.feature,
      label: kindLabel(`ai.evaluation:${row.feature}`),
      state: row.state,
      count: row.count,
      // SAFETY: an aggregate over at least one row with a non-null createdAt.
      oldestAt: iso(row.oldestAt)!,
      errorClass: row.errorClass,
    })),
  };
  return {
    activity,
    drains: queue.drains,
    owed: queue.owed,
    deferring,
    unpublished: evaluations.flatMap((row) =>
      row.unpublishedSince
        ? [
            {
              feature: row.feature,
              count: row.unpublished,
              since: new Date(`${row.unpublishedSince}Z`),
              errorClass: row.errorClass,
            },
          ]
        : [],
    ),
  };
}

/**
 * Owed work with no completion for this long is stuck. Owed is due work, or
 * work that keeps deferring: a Job that re-polls every few seconds is due only
 * for an instant, so its age is its deferral run's (`deferringSince`). A drain sleeps between
 * bursts and its pages finish within minutes, so half an hour of silence is not
 * a pause; it is also half the one-hour lag members were promised, so the alarm
 * shows before that promise breaks.
 */
export const STUCK_WINDOW_MINUTES = 30;
/**
 * A failing drain unit is still being tried when its last page is this recent:
 * the hourly cron runs every due unit, so two hours covers a missed tick. An
 * older failure belongs to a unit that owes nothing now.
 */
const DRAIN_RETRY_MINUTES = 120;
/** Due work this old that is still finishing reads as catching up, not stuck. */
const BEHIND_MINUTES = 15;
const MINUTE_MS = 60_000;

export type { DrainDue };

const minutesAgo = (now: Date, minutes: number) =>
  new Date(now.getTime() - minutes * MINUTE_MS);
/** Raw `execute` rows keep `timestamp` columns as text without a zone; they are UTC. */
const latest = (...values: readonly (Date | null)[]) =>
  values.reduce<Date | null>(
    (best, value) => (value && (!best || value > best) ? value : best),
    null,
  );

/** "45 minutes", "12 hours", "3 days". */
function formatStuckAge(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 90) return countLabel(minutes, "minute");
  if (minutes < 48 * 60) return countLabel(Math.round(minutes / 60), "hour");
  return countLabel(Math.round(minutes / (24 * 60)), "day");
}

const workAction = (
  kind: string,
  needsAttention = false,
): WorkStuckItem["action"] =>
  kind.startsWith("image.")
    ? {
        type: "link",
        label: "View photos",
        href: needsAttention ? "/image-jobs?state=failed" : "/image-jobs",
      }
    : kind.startsWith("embedding.") || kind.startsWith("ai.evaluation")
      ? { type: "none" }
      : {
          type: "retry",
          kinds: [kind],
          ...(needsAttention ? { needsAttention: true } : {}),
        };

const kindLabel = (kind: string) => {
  if (kind === "image.cloud") return "Photo processing in the cloud";
  if (kind === "image.device") return "Photo processing on Apple devices";
  if (kind.startsWith("embedding.")) return "Search embeddings";
  if (kind.startsWith("ai.evaluation:")) {
    const feature = kind.slice("ai.evaluation:".length);
    if (feature === "entity-connections") return "Connection evaluations";
    if (feature === "mailbox-relevance") return "Email relevance";
    if (feature === "mailbox-triage") return "Email triage";
    if (feature === "product-identity") return "Product identity";
    return "Field suggestions";
  }
  const declared = jobKindDeclaration(kind);
  return declared?.activityLabel ?? declared?.label ?? kind;
};

const stoppedItem = (
  kind: string,
  stoppedAt: Date,
  now: Date,
  cause: string | null,
  diagnostic: string | null,
): WorkStuckItem => {
  const declared = jobKindDeclaration(kind)?.stuck;
  return {
    key: kind,
    title: declared?.title ?? `${kindLabel(kind)} stopped`,
    body: [
      cause,
      `Nothing has finished for ${formatStuckAge(now.getTime() - stoppedAt.getTime())}.`,
      declared?.consequence,
    ]
      .filter(Boolean)
      .join(" "),
    since: stoppedAt.toISOString(),
    action: workAction(kind),
    diagnostic,
  };
};

/**
 * Why a stopped unit is not finishing: its Jobs' shared wait, or how long ago
 * a drain unit last got a page while its work was due.
 */
function stoppedCause(unit: WorkQueueUnit, now: Date): string | null {
  if (unit.type === "job")
    return unit.waits.find((wait) => wait.reason !== "turn")?.summary ?? null;
  if (!unit.lastClaimedAt) return "It has never been given a turn.";
  const idle = now.getTime() - new Date(unit.lastClaimedAt).getTime();
  return idle >= STUCK_WINDOW_MINUTES * MINUTE_MS
    ? `It was last given a turn ${formatStuckAge(idle)} ago.`
    : null;
}

/** Rebuild observations read committed movement, never a prior pass's finish as a heartbeat. */
export async function readRebuildObservation(db: Database) {
  const [row] = await getDb(db).select().from(derivedRebuild);
  return {
    running: row?.running ?? false,
    target: row?.target ?? null,
    startedAt: row?.startedAt?.toISOString() ?? null,
    finishedAt: row?.finishedAt?.toISOString() ?? null,
    lastMovementAt: row?.lastMovementAt?.toISOString() ?? null,
    cleanAt: row?.cleanAt?.toISOString() ?? null,
    failures: row?.failures ?? 0,
    error: row?.error ?? null,
    durationsMs: row?.durationsMs ?? [],
    pages: row?.pages ?? 0,
    processedRecords: row?.processedRecords ?? 0,
    failedPages: row?.failedPages ?? 0,
    history: [...(row?.history ?? [])],
  };
}

/**
 * A failing Job's streak start comes from its execution record; rows written
 * before `failingSince` existed fall back to their last update. Its diagnostic
 * names the last execution's error class beside the stored error.
 */
const jobFailingSince = sql`coalesce(j."failingSince", j."updatedAt")`;
const jobLatestDiagnostic = sql`CASE WHEN j."lastExecution"->>'errorClass' IS NULL THEN j.error
  ELSE (j."lastExecution"->>'errorClass') || ': ' || coalesce(j.error, '') END`;

async function readFailedWork(db: Database, now: Date) {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const rows = await getDb(db).execute<{
    kind: string;
    count: number;
    since: string;
    diagnostic: string | null;
  }>(sql`
    WITH failed AS (
      SELECT kind, j."updatedAt" AS at, ${jobFailingSince} AS failing_since, ${jobLatestDiagnostic} AS error FROM "Job" j
      WHERE (state = ${jobState.enum.failed} AND "updatedAt" > ${since}::timestamp
        AND NOT EXISTS (SELECT 1 FROM "Job" done WHERE done.kind = j.kind AND done.state = ${jobState.enum.completed} AND done."updatedAt" > j."updatedAt"))
        OR (state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}) AND attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS})
      UNION ALL SELECT 'ai.evaluation:' || feature, "updatedAt", "updatedAt", error FROM "AiEvaluation" evaluation
        WHERE ((state = ${aiEvaluationState.enum.failed} AND "updatedAt" > ${since}::timestamp)
          OR (state IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.result_ready})
            AND "runAt" IS NOT NULL AND attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}))
          AND NOT ${retried(sql`evaluation.receipt`)}
          AND (NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" request
              WHERE request."evaluationId" = evaluation.id AND ${retried(sql`request.receipt`)})
            OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" request
              WHERE request."evaluationId" = evaluation.id AND request."cancelledAt" IS NULL
                AND NOT ${retried(sql`request.receipt`)}))
      UNION ALL SELECT 'image.' || lane, "updatedAt", "updatedAt", "lastError" FROM "ImageProcessingJob" image_job
        WHERE (state = ${imageProcessingJobState.enum.failed}
          OR (state = ${imageProcessingJobState.enum.pending} AND failures >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}))
          AND ${notDeleted("image_job")} AND EXISTS (SELECT 1 FROM "Image" source
            WHERE source.id = image_job."imageId" AND ${notDeleted("source")}
              AND source.sha256 = image_job."sourceContentHash"
              AND NOT ${appleFailureCoveredByCloudDescriptionSql({ jobAlias: "image_job", imageId: sql`source.id`, sourceContentHash: sql`source.sha256` })})
      UNION ALL SELECT 'embedding.refresh', "updatedAt", "updatedAt", "embeddingError" FROM "SearchDocument"
        WHERE "embeddingAttempts" >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
          AND ("embeddingDueAt" IS NOT NULL OR ("embeddingError" IS NOT NULL AND "updatedAt" > ${since}::timestamp))
          AND ${notDeleted("SearchDocument")}
      -- includes-deleted: a deleted artifact still owes its vector deletion.
      UNION ALL SELECT 'embedding.cleanup', "updatedAt", "updatedAt", "deletionError" FROM "EntityEmbedding"
        WHERE "deletionId" IS NULL AND "deletionAttempts" >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
    ) SELECT kind, count(*)::int AS count, min(failing_since) AS since,
      (array_agg(error ORDER BY at DESC))[1] AS diagnostic FROM failed GROUP BY kind`);
  return rows.rows.map((row): WorkStuckItem => ({
    key: `${row.kind}:failing`,
    title: `${kindLabel(row.kind)} has failed work`,
    body: `${countLabel(row.count, "work item")} ${row.count === 1 ? "needs" : "need"} attention after failures.`,
    since: new Date(`${row.since}Z`).toISOString(),
    diagnostic: row.diagnostic,
    action: workAction(row.kind, true),
  }));
}

/**
 * Stuck rows for drain units, from their record rows and their drains' `due`
 * rows. `stuck` holds the rows already raised, which these never repeat.
 */
function drainUnitItems({
  now,
  activity,
  drains,
  owed,
  stuck,
  queueDiagnostic,
}: {
  now: Date;
  activity: WorkActivity;
  drains: readonly DrainRecord[];
  owed: ReadonlyMap<string, Date>;
  stuck: readonly WorkStuckItem[];
  queueDiagnostic: () => string;
}): WorkStuckItem[] {
  const items: WorkStuckItem[] = [];
  const stuckWindow = minutesAgo(now, STUCK_WINDOW_MINUTES);
  const unitOf = new Map(activity.queue.map((unit) => [unit.unit, unit]));
  // A drain unit has no failed-work row of its own: without this, a unit whose
  // every page throws or defers stops silently (its record row is the only
  // evidence). One deferral is a wait; pages that deferred across the stuck
  // window with none succeeding between are work that is not finishing.
  const covered = (unit: string) =>
    [...stuck, ...items].some(
      (item) =>
        item.key === drainStreamKind(unit) ||
        item.key === `${drainStreamKind(unit)}:failing` ||
        item.key.startsWith(`drain:${unit}:`) ||
        (unit === "derived-rebuild" && item.key.startsWith("derived-rebuild")),
    );
  for (const record of drains) {
    const page = record.lastExecution;
    if (!page) continue;
    const finished = new Date(page.finishedAt);
    if (finished <= minutesAgo(now, DRAIN_RETRY_MINUTES)) continue;
    const failingSince =
      page.outcome === "failed" &&
      record.failingSince &&
      record.failingSince <= stuckWindow
        ? record.failingSince
        : null;
    const deferringSince =
      page.deferringSince &&
      finished.getTime() - new Date(page.deferringSince).getTime() >=
        STUCK_WINDOW_MINUTES * MINUTE_MS
        ? new Date(page.deferringSince)
        : null;
    const since = failingSince ?? deferringSince;
    // A failing unit is named beside its stream; the rebuild has its own row.
    const rebuildShown =
      record.unit === "derived-rebuild" &&
      stuck.some((item) => item.key.startsWith("derived-rebuild"));
    if (!since || rebuildShown || (!failingSince && covered(record.unit)))
      continue;
    const age = formatStuckAge(now.getTime() - since.getTime());
    items.push({
      key: `drain:${record.unit}:${failingSince ? "failing" : "deferring"}`,
      title: `${drainUnitLabel(record.unit)} keeps ${failingSince ? "failing" : "waiting"}`,
      body: failingSince
        ? `Every pass has failed for ${age}, so this work isn't running.`
        : `Every pass has deferred for ${age}, so this work isn't finishing.`,
      since: since.toISOString(),
      action: { type: "none" },
      diagnostic: [
        `${record.unit}: ${page.errorClass ?? page.outcome} at ${page.finishedAt}`,
        failingSince ? record.error : queueDiagnostic(),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  // A drain whose `due` rows report work that has waited out the stuck window
  // with no successful page in it. Units with a stream are judged there, and
  // a unit whose `since` is the read time cannot show how long it has waited.
  const recordOf = new Map(drains.map((record) => [record.unit, record]));
  for (const [unit, since] of owed) {
    const page = recordOf.get(unit)?.lastExecution;
    if (
      since > stuckWindow ||
      activity.streams.some(
        (stream) => stream.kind === drainStreamKind(unit),
      ) ||
      (page?.outcome === "succeeded" &&
        new Date(page.finishedAt) > stuckWindow) ||
      covered(unit)
    )
      continue;
    const queued = unitOf.get(unit);
    items.push({
      key: `drain:${unit}`,
      title: `${drainUnitLabel(unit)} stopped`,
      body: [
        queued ? stoppedCause(queued, now) : null,
        `Its work has waited ${formatStuckAge(now.getTime() - since.getTime())}.`,
      ]
        .filter(Boolean)
        .join(" "),
      since: since.toISOString(),
      action: { type: "none" },
      diagnostic: queueDiagnostic(),
    });
  }
  return items;
}

export async function readBackgroundWorkStatus(
  db: Database,
  now = new Date(),
  drainDues: readonly DrainDue[] = [],
) {
  const [{ activity, drains, owed, deferring, unpublished }, failures] =
    await Promise.all([
      observeWork(db, now, drainDues),
      readFailedWork(db, now),
    ]);
  const rebuild = activity.rebuild;
  const stuck: WorkStuckItem[] = [...failures];
  const stuckWindow = minutesAgo(now, STUCK_WINDOW_MINUTES);
  const unitOf = new Map(activity.queue.map((unit) => [unit.unit, unit]));
  let queueText: string | undefined;
  const queueDiagnostic = () => (queueText ??= describeQueue(activity));
  let behind = false;
  let deviceDueSince: Date | null = null;
  let lastFinishedAt = rebuild.finishedAt ? new Date(rebuild.finishedAt) : null;
  const movement = rebuild.lastMovementAt ?? rebuild.startedAt;
  const since = movement ? new Date(movement) : null;
  if (since && (rebuild.failures >= 3 || since <= minutesAgo(now, 120))) {
    stuck.push({
      key:
        rebuild.failures >= 3 ? "derived-rebuild:failing" : "derived-rebuild",
      title:
        rebuild.failures >= 3
          ? "Totals and search rebuild keeps failing"
          : "Totals and search results stopped updating",
      body:
        rebuild.failures >= 3
          ? `${rebuild.failures} rebuild failures were recorded; ${rebuild.failedPages} pages failed in this pass.`
          : "The rebuild has made no committed progress for two hours.",
      since: since.toISOString(),
      action: { type: "none" },
      diagnostic: rebuild.error,
    });
  } else if (since && since <= minutesAgo(now, 75)) behind = true;
  for (const stream of activity.streams) {
    const completed = stream.lastCompletedAt
      ? new Date(stream.lastCompletedAt)
      : null;
    const due = stream.oldestDueAt ? new Date(stream.oldestDueAt) : null;
    lastFinishedAt = latest(lastFinishedAt, completed);
    if (stream.kind === "image.device") {
      deviceDueSince = due;
      continue;
    }
    if (stuck.some((item) => item.key === `${stream.kind}:failing`)) continue;
    const deferringSince = deferring.get(stream.kind);
    const owedSince =
      due && deferringSince
        ? new Date(Math.min(due.getTime(), deferringSince.getTime()))
        : (due ?? deferringSince);
    if (
      owedSince &&
      owedSince <= stuckWindow &&
      (!completed || completed <= stuckWindow)
    ) {
      const unit = unitOf.get(streamDrainUnit(stream.kind) ?? stream.kind);
      stuck.push(
        stoppedItem(
          stream.kind,
          owedSince,
          now,
          unit ? stoppedCause(unit, now) : null,
          queueDiagnostic(),
        ),
      );
    } else if (due && due <= minutesAgo(now, BEHIND_MINUTES)) behind = true;
  }
  stuck.push(
    ...drainUnitItems({
      now,
      activity,
      drains,
      owed,
      stuck,
      queueDiagnostic,
    }),
  );
  for (const pile of unpublished) {
    const kind = `ai.evaluation:${pile.feature}`;
    if (
      pile.since > stuckWindow ||
      stuck.some((item) => item.key === `${kind}:failing`)
    )
      continue;
    stuck.push({
      key: `${kind}:unpublished`,
      title: `${kindLabel(kind)}: AI answers aren't being saved`,
      body: `${countLabel(pile.count, "AI answer")} ${pile.count === 1 ? "has" : "have"} waited ${formatStuckAge(now.getTime() - pile.since.getTime())} to be saved. Kept answers are not paid for again.`,
      since: pile.since.toISOString(),
      action: { type: "none" },
      diagnostic: [
        pile.errorClass ? `Top error: ${pile.errorClass}` : null,
        queueDiagnostic(),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return { stuck, behind, lastFinishedAt, deviceDueSince };
}
