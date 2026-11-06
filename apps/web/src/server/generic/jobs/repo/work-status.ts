import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobKindDeclaration,
  jobState,
} from "@cubby/schemas/job";
import {
  ATTENTION_RUN_PURPOSES,
  RUN_PURPOSE_LABEL,
  isMemberStartedRun,
  runStatus,
} from "@cubby/schemas/run-fields";
import type { WorkStuckItem } from "@cubby/schemas/work-status";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { DERIVED_REBUILD_KEY } from "~/server/db/derived-rebuild-schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import {
  readRunRollups,
  runStalledSql,
} from "~/server/generic/jobs/repo/job-queue";

/**
 * Due work with no completion for this long is stuck. A drain sleeps between
 * bursts and its pages finish within minutes, so half an hour of silence is not
 * a pause; it is also half the one-hour lag members were promised, so the alarm
 * shows before that promise breaks.
 */
export const STUCK_WINDOW_MINUTES = 30;
/** Due work this old that is still finishing reads as catching up, not stuck. */
const BEHIND_MINUTES = 15;
/** A failure this old with no retry stays in `/jobs` instead of warning forever. */
export const FAILURE_LOOKBACK_DAYS = 7;
/** A scheduled Run retries on its own; this many failures in a row is not a blip. */
const REPEATED_RUN_FAILURES = 3;
const MINUTE_MS = 60_000;

const runLink = (code: string): WorkStuckItem["action"] => ({
  type: "link",
  label: "Open Run",
  href: `/runs/${code}`,
});

const minutesAgo = (now: Date, minutes: number) =>
  new Date(now.getTime() - minutes * MINUTE_MS);
const stamp = (value: Date) => sql`${value.toISOString()}::timestamp`;
/** Raw `execute` rows keep `timestamp` columns as text without a zone; they are UTC. */
const utc = (value: string | null) =>
  value === null ? null : new Date(`${value}Z`);
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

const kindLabel = (kind: string) => {
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
    action: { type: "retry", kinds: [kind] },
    diagnostic,
  };
};

const failingItem = (
  kind: string,
  failedAt: Date,
  attempts: number,
  diagnostic: string | null,
  retry: boolean,
): WorkStuckItem => {
  const declared = jobKindDeclaration(kind)?.stuck;
  return {
    key: `${kind}:failing`,
    title: declared?.failingTitle ?? `${kindLabel(kind)} keeps failing`,
    body: [
      attempts > 1
        ? `The last ${countLabel(attempts, "attempt")} failed.`
        : "The last attempt failed.",
      declared?.consequence,
    ]
      .filter(Boolean)
      .join(" "),
    since: failedAt.toISOString(),
    action: retry
      ? { type: "retry", kinds: [kind], needsAttention: true }
      : { type: "none" },
    diagnostic,
  };
};

type StatusFacts = {
  stuck: WorkStuckItem[];
  behind: boolean;
  lastFinishedAt: Date | null;
};

/** The hourly derived pass: one row, whose kind reports here rather than as a Job. */
async function readDerivedPass(
  db: Database,
  now: Date,
): Promise<StatusFacts & { kinds: Set<string> }> {
  const facts: StatusFacts & { kinds: Set<string> } = {
    stuck: [],
    behind: false,
    lastFinishedAt: null,
    kinds: new Set(["derived.drain"]),
  };
  const rebuild = await getDb(db).execute<{
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    running: boolean;
    failures: number;
    error: string | null;
  }>(sql`
    SELECT "createdAt", "startedAt", "finishedAt", running, failures, error FROM "DerivedRebuild" WHERE key = ${DERIVED_REBUILD_KEY}`);
  const pass = rebuild.rows[0];
  if (pass) {
    const finished = utc(pass.finishedAt);
    const since = finished ?? utc(pass.createdAt);
    facts.lastFinishedAt = latest(facts.lastFinishedAt, finished);
    if (pass.failures >= 3 && since) {
      facts.stuck.push({
        ...failingItem(
          "derived.drain",
          since,
          pass.failures,
          pass.error,
          false,
        ),
        action: { type: "none" },
      });
    } else if (since && since <= minutesAgo(now, 120)) {
      facts.stuck.push({
        ...stoppedItem("derived.drain", since, now, pass.error),
        body: "Two hourly rebuilds have not finished. Records you entered are fine; calculated values may be out of date.",
        action: { type: "none" },
      });
    } else if (since && since <= minutesAgo(now, 75)) facts.behind = true;
  }
  return facts;
}

/**
 * Jobs with their own rows. Live and failed rows are few and the completion
 * probes walk `Job_kind_claimed_idx` backward, so retained history costs
 * nothing.
 */
async function readJobKinds(
  db: Database,
  now: Date,
  drainKinds: ReadonlySet<string>,
): Promise<StatusFacts> {
  const at = stamp(now);
  const live = [
    jobState.enum.queued,
    jobState.enum.retry_wait,
    jobState.enum.running,
  ];
  const { rows } = await getDb(db).execute<{
    kind: string;
    dueSince: string | null;
    lastCompletedAt: string | null;
    failedAt: string | null;
    failedError: string | null;
    failedAttempts: number | null;
    failedLive: boolean | null;
  }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT kind, state, "availableAt", "leaseExpiresAt", "updatedAt", attempts, error
      FROM "Job"
      WHERE state IN (${sql.join(
        live.map((state) => sql`${state}`),
        sql`, `,
      )}) OR (state = ${jobState.enum.failed}
          AND "updatedAt" > ${stamp(new Date(now.getTime() - FAILURE_LOOKBACK_DAYS * 24 * 60 * MINUTE_MS))})
    ), kinds AS (
      SELECT kind,
        min(CASE WHEN state = ${jobState.enum.running} THEN "leaseExpiresAt" ELSE "availableAt" END)
          FILTER (WHERE (state = ${jobState.enum.running} AND "leaseExpiresAt" <= ${at})
            OR (state <> ${jobState.enum.running} AND state <> ${jobState.enum.failed} AND "availableAt" <= ${at})) AS "dueSince",
        (array_agg(jsonb_build_object(
            'at', "updatedAt", 'message', error, 'attempts', attempts,
            'live', state <> ${jobState.enum.failed})
          ORDER BY "updatedAt" DESC)
          FILTER (WHERE state = ${jobState.enum.failed} OR attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}))[1] AS failure
      FROM candidates GROUP BY kind
    )
    SELECT k.kind, k."dueSince", done."updatedAt" AS "lastCompletedAt",
      k.failure->>'at' AS "failedAt", k.failure->>'message' AS "failedError",
      (k.failure->>'attempts')::int AS "failedAttempts",
      (k.failure->>'live')::boolean AS "failedLive"
    FROM kinds k
    LEFT JOIN LATERAL (
      SELECT j."updatedAt" FROM "Job" j
      WHERE j.kind = k.kind AND j."lastClaimedAt" IS NOT NULL AND j.state = ${jobState.enum.completed}
      ORDER BY j."lastClaimedAt" DESC LIMIT 1
    ) done ON true`);
  const lastAny = await getDb(db).execute<{ at: string | null }>(sql`
    SELECT "updatedAt" AS at FROM "Job"
    WHERE "lastClaimedAt" IS NOT NULL AND state = ${jobState.enum.completed}
    ORDER BY "lastClaimedAt" DESC LIMIT 1`);
  const facts: StatusFacts = {
    stuck: [],
    behind: false,
    lastFinishedAt: utc(lastAny.rows[0]?.at ?? null),
  };
  for (const row of rows) {
    const lastCompletedAt = utc(row.lastCompletedAt);
    const dueSince = utc(row.dueSince);
    if (!drainKinds.has(row.kind) && dueSince) {
      if (
        dueSince <= minutesAgo(now, STUCK_WINDOW_MINUTES) &&
        !(
          lastCompletedAt &&
          lastCompletedAt > minutesAgo(now, STUCK_WINDOW_MINUTES)
        )
      ) {
        facts.stuck.push(
          stoppedItem(
            row.kind,
            lastCompletedAt ?? dueSince,
            now,
            row.failedError,
          ),
        );
        continue;
      }
      if (dueSince <= minutesAgo(now, BEHIND_MINUTES)) facts.behind = true;
    }
    const failedAt = utc(row.failedAt);
    // A later success means the kind works; a live repeat failure is still happening.
    if (
      failedAt &&
      (row.failedLive || !lastCompletedAt || lastCompletedAt < failedAt)
    )
      facts.stuck.push(
        failingItem(
          row.kind,
          failedAt,
          row.failedAttempts ?? 1,
          row.failedError ?? "",
          true,
        ),
      );
  }
  return facts;
}

/**
 * Image rows own their execution. Cloud work stops like any other kind; device
 * work waits for something outside the server, so the Apple device rule reads its
 * `deviceDueSince`. Repeated failures of either lane show once.
 */
async function readImageWork(
  db: Database,
  now: Date,
): Promise<StatusFacts & { deviceDueSince: Date | null }> {
  const at = stamp(now);
  const due = sql`coalesce("leaseUntil", "runAt")`;
  const pending = imageProcessingJobState.enum.pending;
  const { rows } = await getDb(db).execute<{
    deviceDueSince: string | null;
    cloudDueSince: string | null;
    lastCompletedAt: string | null;
    failedAt: string | null;
    failedError: string | null;
    failedAttempts: number | null;
  }>(sql`
    WITH failing AS (
      SELECT "updatedAt", "lastError", failures FROM "ImageProcessingJob"
      WHERE state = ${pending} AND failures >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
      ORDER BY "updatedAt" DESC LIMIT 1
    )
    SELECT
      (SELECT min(${due}) FROM "ImageProcessingJob" WHERE state = ${pending} AND lane = ${"device"} AND ${due} <= ${at}) AS "deviceDueSince",
      (SELECT min(${due}) FROM "ImageProcessingJob" WHERE state = ${pending} AND lane = ${"cloud"} AND ${due} <= ${at}) AS "cloudDueSince",
      (SELECT max("completedAt") FROM "ImageProcessingJob" WHERE lane = ${"cloud"}) AS "lastCompletedAt",
      (SELECT "updatedAt" FROM failing) AS "failedAt",
      (SELECT "lastError" FROM failing) AS "failedError",
      (SELECT failures FROM failing) AS "failedAttempts"`);
  const row = rows[0];
  const lastCompletedAt = utc(row?.lastCompletedAt ?? null);
  const cloudDueSince = utc(row?.cloudDueSince ?? null);
  const failedAt = utc(row?.failedAt ?? null);
  const facts: StatusFacts & { deviceDueSince: Date | null } = {
    stuck: [],
    behind: false,
    lastFinishedAt: lastCompletedAt,
    deviceDueSince: utc(row?.deviceDueSince ?? null),
  };
  const moving =
    lastCompletedAt && lastCompletedAt > minutesAgo(now, STUCK_WINDOW_MINUTES);
  if (
    cloudDueSince &&
    cloudDueSince <= minutesAgo(now, STUCK_WINDOW_MINUTES) &&
    !moving
  )
    facts.stuck.push({
      ...stoppedItem(
        "image.cloud",
        lastCompletedAt ?? cloudDueSince,
        now,
        row?.failedError ?? null,
      ),
      title: "Photo processing in the cloud stopped",
      action: {
        type: "link",
        label: "View photos",
        href: "/image-jobs?state=pending",
      },
    });
  else if (cloudDueSince && cloudDueSince <= minutesAgo(now, BEHIND_MINUTES))
    facts.behind = true;
  if (failedAt)
    facts.stuck.push({
      ...failingItem(
        "image",
        failedAt,
        row?.failedAttempts ?? 1,
        row?.failedError ?? null,
        false,
      ),
      title: "Photo processing keeps failing",
      action: {
        type: "link",
        label: "View photos",
        href: "/image-jobs?state=failed",
      },
    });
  return facts;
}

/** Embeddings owed on search documents, and when one last finished indexing. */
async function readEmbeddingWork(
  db: Database,
  now: Date,
): Promise<StatusFacts> {
  const at = stamp(now);
  const { rows } = await getDb(db).execute<{
    dueSince: string | null;
    lastIndexedAt: string | null;
    failedAt: string | null;
    failedError: string | null;
    failedAttempts: number | null;
  }>(sql`
    WITH failing AS (
      SELECT "updatedAt", "embeddingError", "embeddingAttempts" FROM "SearchDocument"
      WHERE "embeddingDueAt" IS NOT NULL AND "embeddingAttempts" >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
      ORDER BY "embeddingDueAt" LIMIT 1
    )
    SELECT
      (SELECT min("embeddingDueAt") FROM "SearchDocument"
        WHERE "embeddingDueAt" <= ${at} AND coalesce("embeddingLeaseUntil" <= ${at}, true)) AS "dueSince",
      (SELECT max("indexedAt") FROM "EntityEmbedding") AS "lastIndexedAt",
      (SELECT "updatedAt" FROM failing) AS "failedAt",
      (SELECT "embeddingError" FROM failing) AS "failedError",
      (SELECT "embeddingAttempts" FROM failing) AS "failedAttempts"`);
  const row = rows[0];
  const dueSince = utc(row?.dueSince ?? null);
  const lastFinishedAt = utc(row?.lastIndexedAt ?? null);
  const facts: StatusFacts = { stuck: [], behind: false, lastFinishedAt };
  const action: WorkStuckItem["action"] = { type: "none" };
  if (dueSince && dueSince <= minutesAgo(now, STUCK_WINDOW_MINUTES)) {
    if (
      !lastFinishedAt ||
      lastFinishedAt <= minutesAgo(now, STUCK_WINDOW_MINUTES)
    )
      facts.stuck.push({
        ...stoppedItem(
          "embedding.refresh",
          lastFinishedAt ?? dueSince,
          now,
          row?.failedError ?? null,
        ),
        title: "Search embeddings stopped",
        action,
      });
    else facts.behind = true;
  } else if (dueSince && dueSince <= minutesAgo(now, BEHIND_MINUTES))
    facts.behind = true;
  const failedAt = utc(row?.failedAt ?? null);
  if (failedAt)
    facts.stuck.push({
      ...failingItem(
        "embedding.refresh",
        failedAt,
        row?.failedAttempts ?? 1,
        row?.failedError ?? null,
        false,
      ),
      title: "Search embeddings keep failing",
      action,
    });
  return facts;
}

/**
 * Evaluations the AI drain owes. A funding or provider wait pushes their due time
 * ahead, so it reads as waiting rather than stopped; a parked evaluation owes nothing.
 */
async function readAiEvaluationWork(
  db: Database,
  now: Date,
): Promise<StatusFacts> {
  const at = stamp(now);
  const { rows } = await getDb(db).execute<{
    dueSince: string | null;
    lastFinishedAt: string | null;
    failedAt: string | null;
    failedError: string | null;
    failedAttempts: number | null;
  }>(sql`
    WITH failing AS (
      SELECT "updatedAt", error, attempts FROM "AiEvaluation"
      WHERE "runAt" IS NOT NULL AND attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS}
      ORDER BY "updatedAt" DESC LIMIT 1
    )
    SELECT
      (SELECT min("runAt") FROM "AiEvaluation" WHERE "runAt" <= ${at}) AS "dueSince",
      (SELECT "updatedAt" FROM "AiEvaluation"
        WHERE state NOT IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.result_ready})
        ORDER BY "updatedAt" DESC LIMIT 1) AS "lastFinishedAt",
      (SELECT "updatedAt" FROM failing) AS "failedAt",
      (SELECT error FROM failing) AS "failedError",
      (SELECT attempts FROM failing) AS "failedAttempts"`);
  const row = rows[0];
  const dueSince = utc(row?.dueSince ?? null);
  const lastFinishedAt = utc(row?.lastFinishedAt ?? null);
  const facts: StatusFacts = { stuck: [], behind: false, lastFinishedAt };
  const action: WorkStuckItem["action"] = { type: "none" };
  const consequence = "Suggestions won't update until this works.";
  if (dueSince && dueSince <= minutesAgo(now, STUCK_WINDOW_MINUTES)) {
    if (
      !lastFinishedAt ||
      lastFinishedAt <= minutesAgo(now, STUCK_WINDOW_MINUTES)
    ) {
      const item = stoppedItem(
        "ai.evaluation",
        lastFinishedAt ?? dueSince,
        now,
        row?.failedError ?? null,
      );
      facts.stuck.push({
        ...item,
        title: "AI evaluations stopped",
        body: `${item.body} ${consequence}`,
        action,
      });
    } else facts.behind = true;
  } else if (dueSince && dueSince <= minutesAgo(now, BEHIND_MINUTES))
    facts.behind = true;
  const failedAt = utc(row?.failedAt ?? null);
  if (failedAt) {
    const item = failingItem(
      "ai.evaluation",
      failedAt,
      row?.failedAttempts ?? 1,
      row?.failedError ?? null,
      false,
    );
    facts.stuck.push({
      ...item,
      title: "AI evaluations keep failing",
      body: `${item.body} ${consequence}`,
      action,
    });
  }
  return facts;
}

/**
 * Runs a member started or reviews that stopped. Stalled Runs are listed one by
 * one. Failures collapse to each purpose's latest and clear when a later Run of
 * that purpose completes. A member's own failed Run shows at once; a scheduled
 * or discovered Run retries on its own, so it counts only once it keeps failing.
 * Paused Runs are a member's choice.
 */
async function readStoppedRuns(db: Database, now: Date) {
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

export async function readBackgroundWorkStatus(db: Database, now = new Date()) {
  const drains = await readDerivedPass(db, now);
  const [kinds, images, embeddings, evaluations, runs] = await Promise.all([
    readJobKinds(db, now, drains.kinds),
    readImageWork(db, now),
    readEmbeddingWork(db, now),
    readAiEvaluationWork(db, now),
    readStoppedRuns(db, now),
  ]);
  // A kind that stopped says so once, whichever row noticed first.
  const seen = new Set<string>();
  const stuck = [
    ...drains.stuck,
    ...kinds.stuck,
    ...images.stuck,
    ...embeddings.stuck,
    ...evaluations.stuck,
  ].filter((item) => {
    const kind = item.key.replace(/:failing$/, "");
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
  return {
    stuck: [...stuck, ...runs],
    behind:
      drains.behind ||
      kinds.behind ||
      images.behind ||
      embeddings.behind ||
      evaluations.behind,
    lastFinishedAt: latest(
      drains.lastFinishedAt,
      kinds.lastFinishedAt,
      images.lastFinishedAt,
      embeddings.lastFinishedAt,
      evaluations.lastFinishedAt,
    ),
    deviceDueSince: images.deviceDueSince,
  };
}
