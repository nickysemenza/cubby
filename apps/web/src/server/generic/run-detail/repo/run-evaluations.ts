import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import { eq, sql } from "drizzle-orm";

import type { RunEvaluationsOut } from "~/contracts/run-detail.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { connectionDiscoveryPosition } from "~/server/domains/run/repo/connection-refresh";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/** Latest settled evaluations listed per Run. */
const RECENT_OUTCOMES = 40;
/** Completions per minute are averaged over this window. */
const PACE_MINUTES = 5;

const S = aiEvaluationState.enum;
const OPEN = [S.queued, S.retry_wait, S.result_ready, S.blocked];

/**
 * A Run's AI evaluations by record kind and feature, its recent pace, and its
 * latest settled outcomes (candidate counts, obsolete reasons, errors).
 * Durations are each Job's last claim to its settlement. Reads stay within
 * the Run (`AiEvaluation_run_state_idx`); Jobs join by their unique key.
 */
async function readRunEvaluations(
  db: Database,
  input: { runId: string; purpose: string; failedOnly?: boolean },
  now = new Date(),
): Promise<RunEvaluationsOut> {
  const at = sql`${now.toISOString()}::timestamp`;
  const open = sql.join(
    OPEN.map((state) => sql`${state}`),
    sql`, `,
  );
  const kinds = await getDb(db).execute<{
    entity: string | null;
    feature: string;
    waiting: number;
    running: number;
    completed: number;
    failed: number;
    obsolete: number;
    cancelled: number;
    averageSeconds: number | null;
    completedPace: number;
    lastCompletedAt: string | null;
  }>(sql`
    SELECT e.target->>'entity' AS entity, e.feature,
      count(*) FILTER (WHERE e.state IN (${open}))::int AS waiting,
      count(*) FILTER (WHERE e.state = ${S.running})::int AS running,
      count(*) FILTER (WHERE e.state = ${S.completed})::int AS completed,
      count(*) FILTER (WHERE e.state = ${S.failed})::int AS failed,
      count(*) FILTER (WHERE e.state = ${S.obsolete})::int AS obsolete,
      count(*) FILTER (WHERE e.state = ${S.cancelled})::int AS cancelled,
      avg(extract(epoch FROM j."updatedAt" - j."lastClaimedAt"))
        FILTER (WHERE e.state = ${S.completed} AND j."lastClaimedAt" IS NOT NULL)::float8 AS "averageSeconds",
      count(*) FILTER (WHERE e.state = ${S.completed}
        AND e."updatedAt" > ${at} - ${PACE_MINUTES} * interval '1 minute')::int AS "completedPace",
      max(e."updatedAt") FILTER (WHERE e.state = ${S.completed}) AS "lastCompletedAt"
    FROM "AiEvaluation" e
    LEFT JOIN "Job" j ON j.key = 'ai-evaluation:' || e.id::text
    WHERE e."runId" = ${input.runId}::uuid
    GROUP BY 1, 2
    ORDER BY count(*) DESC
  `);
  const recent = await getDb(db).execute<{
    id: string;
    entity: string | null;
    recordCode: string | null;
    feature: string;
    state: string;
    candidates: number | null;
    reason: string | null;
    error: string | null;
    seconds: number | null;
    settledAt: string;
  }>(sql`
    SELECT e.id, e.target->>'entity' AS entity, ent.shortcode AS "recordCode",
      e.feature, e.state,
      (e.receipt->>'candidates')::int AS candidates,
      e.receipt->>'reason' AS reason,
      left(e.error::text, 300) AS error,
      extract(epoch FROM j."updatedAt" - j."lastClaimedAt")::float8 AS seconds,
      e."updatedAt" AS "settledAt"
    FROM "AiEvaluation" e
    LEFT JOIN "Job" j ON j.key = 'ai-evaluation:' || e.id::text
    LEFT JOIN "Entity" ent ON ent.id = (e.target->>'recordId')::uuid
    WHERE e."runId" = ${input.runId}::uuid
      AND e.state IN (${
        input.failedOnly
          ? sql`${S.failed}`
          : sql`${S.completed}, ${S.failed}, ${S.obsolete}, ${S.blocked}`
      })
    ORDER BY e."updatedAt" DESC
    LIMIT ${RECENT_OUTCOMES}
  `);
  const iso = (value: string | null) =>
    value === null ? null : new Date(`${value}Z`).toISOString();
  const byKind = kinds.rows.map((row) => ({
    entity: row.entity,
    feature: row.feature,
    waiting: row.waiting,
    running: row.running,
    completed: row.completed,
    failed: row.failed,
    obsolete: row.obsolete,
    cancelled: row.cancelled,
    averageSeconds: row.averageSeconds,
  }));
  const completedPace = kinds.rows.reduce(
    (sum, row) => sum + row.completedPace,
    0,
  );
  const lastCompletedAt = kinds.rows
    .map((row) => iso(row.lastCompletedAt))
    .filter((value) => value !== null)
    .sort()
    .at(-1);
  return {
    measuredAt: now.toISOString(),
    pace: {
      windowMinutes: PACE_MINUTES,
      completedPerMinute: completedPace / PACE_MINUTES,
      lastCompletedAt: lastCompletedAt ?? null,
    },
    roster:
      input.purpose === "connection_discovery"
        ? await connectionDiscoveryPosition(db, input.runId)
        : null,
    byKind,
    recent: recent.rows.map((row) => ({
      id: row.id,
      entity: row.entity,
      recordCode: row.recordCode,
      feature: row.feature,
      state: row.state,
      candidates: row.candidates,
      reason: row.reason,
      error: row.error,
      seconds: row.seconds,
      settledAt: iso(row.settledAt) ?? now.toISOString(),
    })),
  };
}

/** The Run detail read: resolves the Run's code and purpose first. */
export async function readRunEvaluationsByCode(
  db: Database,
  code: string,
  failedOnly: boolean,
) {
  const runId = await resolveOrThrow(db, "run", code);
  const [owner] = await getDb(db)
    .select({ purpose: run.purpose })
    .from(run)
    .where(eq(run.id, runId));
  if (!owner) throw new Error(`Run ${code} not found`);
  return readRunEvaluations(db, { runId, purpose: owner.purpose, failedOnly });
}
