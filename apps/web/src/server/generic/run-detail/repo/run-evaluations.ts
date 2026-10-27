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
const OPEN = [S.queued, S.result_ready, S.blocked];

/**
 * A Run's AI evaluations by record kind and feature, its recent pace, and its
 * latest settled outcomes (candidate counts, obsolete reasons, errors).
 * Reads stay within the Run’s request index (`AiEvaluationRequest_run_item_key`).
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
  // The Run requests execution; it need not be the shared evaluation's owner.
  const requested = sql`requested AS MATERIALIZED (
    SELECT e.id, e.target, e.feature, e."updatedAt",
      CASE WHEN request."cancelledAt" IS NOT NULL THEN ${S.cancelled} ELSE e.state END AS state,
      CASE WHEN request."cancelledAt" IS NOT NULL AND request.receipt IS NULL THEN NULL
        ELSE coalesce(request.receipt, e.receipt) END AS receipt,
      CASE WHEN request."cancelledAt" IS NOT NULL THEN 'Cancelled by a member'::text ELSE e.error END AS error
    FROM "AiEvaluationRequest" request JOIN "AiEvaluation" e ON e.id = request."evaluationId"
    WHERE request."runId" = ${input.runId}::uuid
  )`;
  const kinds = await getDb(db).execute<{
    entity: string | null;
    feature: string;
    waiting: number;
    completed: number;
    failed: number;
    obsolete: number;
    cancelled: number;
    completedPace: number;
    lastCompletedAt: string | null;
  }>(sql`
    WITH ${requested}
    SELECT e.target->>'entity' AS entity, e.feature,
      count(*) FILTER (WHERE e.state IN (${open}))::int AS waiting,
      count(*) FILTER (WHERE e.state = ${S.completed})::int AS completed,
      count(*) FILTER (WHERE e.state = ${S.failed})::int AS failed,
      count(*) FILTER (WHERE e.state = ${S.obsolete})::int AS obsolete,
      count(*) FILTER (WHERE e.state = ${S.cancelled})::int AS cancelled,
      count(*) FILTER (WHERE e.state = ${S.completed}
        AND e."updatedAt" > ${at} - ${PACE_MINUTES} * interval '1 minute')::int AS "completedPace",
      max(e."updatedAt") FILTER (WHERE e.state = ${S.completed}) AS "lastCompletedAt"
    FROM requested e
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
    settledAt: string;
  }>(sql`
    WITH ${requested}
    SELECT e.id, e.target->>'entity' AS entity, ent.shortcode AS "recordCode",
      e.feature, e.state,
      (e.receipt->>'candidates')::int AS candidates,
      e.receipt->>'reason' AS reason,
      left(e.error::text, 300) AS error,
      e."updatedAt" AS "settledAt"
    FROM requested e
    LEFT JOIN "Entity" ent ON ent.id = (e.target->>'recordId')::uuid
    WHERE e.state IN (${
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
    completed: row.completed,
    failed: row.failed,
    obsolete: row.obsolete,
    cancelled: row.cancelled,
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
