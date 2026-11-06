import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
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
import { jobState } from "@cubby/schemas/job";
import type { WorkActivity } from "@cubby/schemas/job";
import type { WorkStuckItem } from "@cubby/schemas/work-status";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { derivedRebuild } from "~/server/db/derived-rebuild-schema";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { run } from "~/server/db/retained-tables";
import { INTERNAL_JOB_KINDS } from "~/server/generic/jobs/kind-policy";
import { jobDue } from "~/server/generic/jobs/repo/queue";

/** Completions and failures are counted over these recent windows. */
const RECENT_MINUTES = { pace: 5, completed: 15, failed: 60 } as const;
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
  const { rows } = await getDb(db).execute<StreamRow>(sql`
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
    GROUP BY p.lane`);
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
  const { rows } = await getDb(db).execute<
    Omit<StreamRow, "paused" | "runs" | "failed" | "kind"> & {
      cleanupDue: number;
      cleanupLater: number;
    }
  >(sql`
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
      (SELECT count(*)::int FROM retired WHERE retry > ${at}) AS "cleanupLater"`);
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
  const owed = sql`e."runAt" IS NOT NULL`;
  const held = sql`e."leaseUntil" > ${at}`;
  const later = sql`${owed} AND NOT coalesce(${held}, false) AND e."runAt" > ${at}`;
  const claimable = sql`${owed} AND NOT coalesce(${held}, false) AND e."runAt" <= ${at}`;
  const { rows } = await getDb(db).execute<StreamRow>(sql`
    SELECT 'ai.evaluation:' || e.feature AS kind,
      count(*) FILTER (WHERE ${held})::int AS "running",
      count(*) FILTER (WHERE ${claimable})::int AS "due",
      count(*) FILTER (WHERE ${later} AND e.attempts > 0)::int AS "backingOff",
      count(*) FILTER (WHERE ${later} AND e.attempts = 0)::int AS "scheduled",
      0 AS "paused",
      count(*) FILTER (WHERE e.state = ${aiEvaluationState.enum.completed} AND e."updatedAt" > ${since(RECENT_MINUTES.pace)})::int AS "completedPace",
      count(*) FILTER (WHERE e.state = ${aiEvaluationState.enum.completed} AND e."updatedAt" > ${since(RECENT_MINUTES.completed)})::int AS "completed",
      count(*) FILTER (WHERE e.state = ${aiEvaluationState.enum.failed} AND e."updatedAt" > ${since(RECENT_MINUTES.failed)})::int AS "failed",
      max(e."updatedAt") FILTER (WHERE e.state = ${aiEvaluationState.enum.completed}) AS "lastCompletedAt",
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
    GROUP BY e.feature`);
  return rows;
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
): Promise<WorkActivity> {
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
  return {
    rebuild: await readRebuildObservation(db),
    measuredAt: now.toISOString(),
    windows: {
      paceMinutes: RECENT_MINUTES.pace,
      completedMinutes: RECENT_MINUTES.completed,
      failedMinutes: RECENT_MINUTES.failed,
    },
    streams: [
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
      ),
  };
}

/**
 * Due work with no completion for this long is stuck. A drain sleeps between
 * bursts and its pages finish within minutes, so half an hour of silence is not
 * a pause; it is also half the one-hour lag members were promised, so the alarm
 * shows before that promise breaks.
 */
export const STUCK_WINDOW_MINUTES = 30;
/** Due work this old that is still finishing reads as catching up, not stuck. */
const BEHIND_MINUTES = 15;
const MINUTE_MS = 60_000;

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
    ? { type: "link", label: "View photos", href: "/image-jobs?state=pending" }
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
  if (kind.startsWith("ai.evaluation")) return "AI evaluations";
  const declared = jobKindDeclaration(kind);
  return declared?.activityLabel ?? declared?.label ?? kind;
};

const stoppedItem = (
  kind: string,
  stoppedAt: Date,
  now: Date,
  diagnostic: string | null,
): WorkStuckItem => {
  const declared = jobKindDeclaration(kind)?.stuck;
  return {
    key: kind,
    title: declared?.title ?? `${kindLabel(kind)} stopped`,
    body: [
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

async function readFailedWork(db: Database, now: Date) {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const rows = await getDb(db).execute<{
    kind: string;
    count: number;
    since: string;
    diagnostic: string | null;
  }>(sql`
    WITH failed AS (
      SELECT kind, "updatedAt" AS at, error FROM "Job" j
      WHERE (state = ${jobState.enum.failed} AND "updatedAt" > ${since}::timestamp
        AND NOT EXISTS (SELECT 1 FROM "Job" done WHERE done.kind = j.kind AND done.state = ${jobState.enum.completed} AND done."updatedAt" > j."updatedAt"))
        OR (state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}) AND attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS})
      UNION ALL SELECT 'ai.evaluation:' || feature, "updatedAt", error FROM "AiEvaluation"
        WHERE (state = ${aiEvaluationState.enum.failed} AND "updatedAt" > ${since}::timestamp)
          OR ("runAt" IS NOT NULL AND attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS})
      UNION ALL SELECT 'image.' || lane, "updatedAt", "lastError" FROM "ImageProcessingJob"
        WHERE state = ${imageProcessingJobState.enum.pending} AND failures >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
      UNION ALL SELECT 'embedding.refresh', "updatedAt", "embeddingError" FROM "SearchDocument"
        WHERE "embeddingDueAt" IS NOT NULL AND "embeddingAttempts" >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
          AND ${notDeleted("SearchDocument")}
    ) SELECT kind, count(*)::int AS count, max(at) AS since,
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

export async function readBackgroundWorkStatus(db: Database, now = new Date()) {
  const [activity, failures] = await Promise.all([
    readWorkActivity(db, now),
    readFailedWork(db, now),
  ]);
  const rebuild = activity.rebuild;
  const stuck: WorkStuckItem[] = [...failures];
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
    if (
      due &&
      due <= minutesAgo(now, STUCK_WINDOW_MINUTES) &&
      (!completed || completed <= minutesAgo(now, STUCK_WINDOW_MINUTES))
    ) {
      stuck.push(stoppedItem(stream.kind, due, now, null));
    } else if (due && due <= minutesAgo(now, BEHIND_MINUTES)) behind = true;
  }
  return { stuck, behind, lastFinishedAt, deviceDueSince };
}
