import { runShortcode } from "@cubby/schemas/identifiers";
import { jobState } from "@cubby/schemas/job";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { WorkActivity } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { INTERNAL_JOB_KINDS } from "~/server/generic/jobs/kind-policy";
import { jobDue } from "~/server/generic/jobs/repo/queue";

/** Completions and failures are counted over these recent windows. */
const RECENT_MINUTES = { pace: 5, completed: 15, failed: 60 } as const;
/** Active Runs named per stream, newest first. */
const STREAM_RUNS = 3;

/**
 * Live and recent work per Job kind, with AI evaluations split by feature:
 * what runs now, what waits and why, and how fast recent work finished.
 * Internal maintenance kinds are omitted. Only Jobs that are live or were
 * claimed within the failure window are read (`Job_due_idx`,
 * `Job_claimed_idx`), so cost follows current work, not retained history.
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
  const rows = await getDb(db).execute<{
    kind: string;
    feature: string | null;
    running: number;
    due: number;
    backingOff: number;
    scheduled: number;
    paused: number;
    completedPace: number;
    completed: number;
    failed: number;
    lastCompletedAt: string | null;
    oldestDueAt: string | null;
    runs: string[] | null;
  }>(sql`
    WITH activity_jobs AS MATERIALIZED (
      SELECT "Job".*, e.feature, e.id AS "evaluationId" FROM "Job"
      LEFT JOIN "AiEvaluation" e ON "Job".kind = 'ai.evaluation' AND e.id = ("Job".input->>'evaluationId')::uuid
      WHERE (${live} OR "Job"."lastClaimedAt" > ${since(RECENT_MINUTES.failed)})
        AND "Job".kind NOT IN (${sql.join(
          INTERNAL_JOB_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})
    )
    SELECT "Job".kind,
      "Job".feature,
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.running} AND "Job"."leaseExpiresAt" > ${at})::int AS "running",
      count(*) FILTER (WHERE ${waiting})::int AS "due",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.retry_wait} AND "Job"."availableAt" > ${at})::int AS "backingOff",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.queued} AND "Job"."availableAt" > ${at})::int AS "scheduled",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.paused})::int AS "paused",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.completed} AND "Job"."updatedAt" > ${since(RECENT_MINUTES.pace)})::int AS "completedPace",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.completed} AND "Job"."updatedAt" > ${since(RECENT_MINUTES.completed)})::int AS "completed",
      count(*) FILTER (WHERE "Job".state = ${jobState.enum.failed} AND "Job"."updatedAt" > ${since(RECENT_MINUTES.failed)})::int AS "failed",
      max("Job"."updatedAt") FILTER (WHERE "Job".state = ${jobState.enum.completed}) AS "lastCompletedAt",
      min(CASE WHEN "Job".state = ${jobState.enum.running} THEN "Job"."leaseExpiresAt" ELSE "Job"."availableAt" END)
        FILTER (WHERE ${waiting}) AS "oldestDueAt",
      ARRAY(
        SELECT r.shortcode FROM activity_jobs stream
        CROSS JOIN LATERAL (
          SELECT stream."runId" AS id WHERE stream."runId" IS NOT NULL
          UNION
          SELECT request."runId" FROM "AiEvaluationRequest" request
          WHERE request."evaluationId" = stream."evaluationId" AND request."cancelledAt" IS NULL
        ) demand
        JOIN "Run" r ON r.id = demand.id
        WHERE stream.kind = "Job".kind AND stream.feature IS NOT DISTINCT FROM "Job".feature
          AND ${notDeleted(requester)} AND r.status IN (${sql.join(
            ACTIVE_RUN_STATUSES.map((status) => sql`${status}`),
            sql`, `,
          )})
        GROUP BY r.id ORDER BY r."createdAt" DESC, r.id LIMIT ${STREAM_RUNS}
      ) AS "runs"
    FROM activity_jobs "Job"
    GROUP BY "Job".kind, "Job".feature
    ORDER BY "Job".kind, "Job".feature
  `);
  const iso = (value: string | null) =>
    value === null ? null : new Date(`${value}Z`).toISOString();
  return {
    measuredAt: now.toISOString(),
    windows: {
      paceMinutes: RECENT_MINUTES.pace,
      completedMinutes: RECENT_MINUTES.completed,
      failedMinutes: RECENT_MINUTES.failed,
    },
    streams: rows.rows
      .map((row) => ({
        kind: row.kind,
        feature: row.feature,
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
