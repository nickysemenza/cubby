/**
 * What a Run's current evaluations add up to, computed in SQL. A wait page repeats every
 * minute or so over a roster that reaches tens of thousands of rows, so it never loads it.
 *
 * Each read applies the rules the rows used to be filtered by in application code: a retried
 * evaluation is not current, a requested one takes its request's cancellation and receipt, and
 * a connection target must be well formed. `evaluation-tally.integration.test.ts` holds them
 * equal to those rules.
 */
import {
  aiEvaluationState,
  aiEvaluationTargetKind,
  MEMBER_CANCELLED_AI_WORK,
} from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { RUN_STEP_ERROR_SAMPLE } from "@cubby/schemas/run-step";
import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import { z } from "zod";

import { hasEvaluationRetryReceipt } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import { aiEvaluation, aiEvaluationRequest } from "~/server/db/schema";

export type EvaluationScope = { runId: RunId | SQL } & (
  | { source: "owned"; connectionsOnly?: boolean }
  | { source: "requested"; executionKind?: string }
);

const UUID_PATTERN = z.regexes.uuid().source;
const uuidString = (value: SQLWrapper) =>
  sql`(jsonb_typeof(${value}) = 'string' AND (${value} #>> '{}') ~ ${UUID_PATTERN})`;

const connectionTarget = () => {
  const field = (key: string) =>
    sql`(${outer(aiEvaluation.target)} -> ${key}::text)`;
  return sql`(${field("kind")} = to_jsonb(${aiEvaluationTargetKind.enum.connection}::text)
    AND jsonb_typeof(${field("entity")}) = 'string'
    AND ${uuidString(field("recordId"))}
    AND jsonb_typeof(${field("field")}) = 'null'
    AND ${field("suggestionIds")} = '[]'::jsonb)`;
};

/** A cancelled request hides a falsy receipt; otherwise its own receipt wins over the shared one. */
const requestedReceipt = () => sql`(CASE
  WHEN ${outer(aiEvaluationRequest.cancelledAt)} IS NOT NULL
    AND (${outer(aiEvaluationRequest.receipt)} IS NULL
      OR ${outer(aiEvaluationRequest.receipt)} IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb))
  THEN NULL
  ELSE coalesce(NULLIF(${outer(aiEvaluationRequest.receipt)}, 'null'::jsonb), ${outer(aiEvaluation.receipt)})
END)`;

function reads(scope: EvaluationScope) {
  const owned = scope.source === "owned";
  const state = owned
    ? sql`${outer(aiEvaluation.state)}`
    : sql`(CASE WHEN ${outer(aiEvaluationRequest.cancelledAt)} IS NOT NULL
        THEN ${aiEvaluationState.enum.cancelled} ELSE ${outer(aiEvaluation.state)} END)`;
  const receipt = owned
    ? sql`${outer(aiEvaluation.receipt)}`
    : requestedReceipt();
  const error = owned
    ? sql<string | null>`${outer(aiEvaluation.error)}`
    : sql<
        string | null
      >`(CASE WHEN ${outer(aiEvaluationRequest.cancelledAt)} IS NOT NULL
        THEN ${MEMBER_CANCELLED_AI_WORK} ELSE ${outer(aiEvaluation.error)} END)`;
  const scopeWhere = and(
    owned
      ? sql`${outer(aiEvaluation.runId)} = ${scope.runId}`
      : sql`${outer(aiEvaluationRequest.runId)} = ${scope.runId}`,
    owned
      ? scope.connectionsOnly
        ? connectionTarget()
        : undefined
      : scope.executionKind
        ? sql`${outer(aiEvaluation.executionKind)} = ${scope.executionKind}`
        : undefined,
  );
  return {
    scopeWhere,
    from: owned
      ? sql`${aiEvaluation}`
      : sql`${aiEvaluation} INNER JOIN ${aiEvaluationRequest} ON ${outer(aiEvaluationRequest.evaluationId)} = ${outer(aiEvaluation.id)}`,
    state,
    receipt,
    error,
    order: owned
      ? [aiEvaluation.createdAt, aiEvaluation.id]
      : [aiEvaluationRequest.sequence, aiEvaluationRequest.id],
    where: and(scopeWhere, sql`NOT ${hasEvaluationRetryReceipt(receipt)}`),
    query<S extends SelectedFields>(db: Database, selection: S) {
      const base = getDb(db).select(selection).from(aiEvaluation).$dynamic();
      // A dynamic builder joins in place, so both sources keep one result type.
      if (!owned)
        void base.innerJoin(
          aiEvaluationRequest,
          eq(aiEvaluationRequest.evaluationId, aiEvaluation.id),
        );
      return base;
    },
  };
}

/** Durable roster existence, including handed-off history. */
export function evaluationRosterExists(scope: EvaluationScope): SQL<boolean> {
  const { from, scopeWhere } = reads(scope);
  return sql<boolean>`EXISTS (SELECT 1 FROM ${from} WHERE ${scopeWhere})`;
}

/**
 * Current failures/pending work and uncertain handoffs keep recovery visible.
 * Owned retry writers insert fresh rows atomically; requested retries can reuse
 * existing work or transfer demand to another owner. Scoped request receipts
 * still win when present. Missing targets, cycles and paths beyond 64 edges fail closed.
 */
export function evaluationRecoveryExists(scope: EvaluationScope): SQL<boolean> {
  const { from, scopeWhere, state, receipt } = reads(scope);
  const validRetry = hasEvaluationRetryReceipt(sql`walk.receipt`);
  return sql<boolean>`EXISTS (
    WITH RECURSIVE roster AS MATERIALIZED (
      SELECT ${outer(aiEvaluation.id)} AS id, ${state} AS state, ${receipt} AS receipt
      FROM ${from} WHERE ${scopeWhere}
    ), walk AS (
      SELECT id, receipt, ARRAY[id] AS path, false AS cycle FROM roster
      WHERE receipt ? 'retryEvaluationId'
      UNION ALL
      SELECT next.id, CASE WHEN scoped_target.id IS NOT NULL
        THEN scoped_target.receipt ELSE next.receipt END,
        walk.path || next.id, next.id = ANY(walk.path)
      FROM walk JOIN ${aiEvaluation} next ON next.id = CASE WHEN ${validRetry}
        THEN (walk.receipt->>'retryEvaluationId')::uuid END
      LEFT JOIN roster scoped_target ON scoped_target.id = next.id
      WHERE NOT walk.cycle AND cardinality(walk.path) < 66
        AND walk.receipt ? 'retryEvaluationId'
    )
    SELECT 1 FROM roster WHERE NOT ${hasEvaluationRetryReceipt(sql`roster.receipt`)}
      AND state NOT IN (${aiEvaluationState.enum.completed}, ${aiEvaluationState.enum.blocked}, ${aiEvaluationState.enum.obsolete}, ${aiEvaluationState.enum.cancelled})
    UNION ALL
    SELECT 1 FROM walk WHERE cycle OR cardinality(path) >= 66
      OR (receipt ? 'retryEvaluationId' AND (NOT ${validRetry}
        OR NOT EXISTS (SELECT 1 FROM ${aiEvaluation} replacement WHERE replacement.id =
          CASE WHEN ${validRetry} THEN (walk.receipt->>'retryEvaluationId')::uuid END)))
  )`;
}

function tallyColumns(state: SQL) {
  const count = (value: string) =>
    sql<number>`(count(*) FILTER (WHERE ${state} = ${value}))::int`;
  const { enum: states } = aiEvaluationState;
  return {
    total: sql<number>`count(*)::int`,
    queued: count(states.queued),
    resultReady: count(states.result_ready),
    completed: count(states.completed),
    blocked: count(states.blocked),
    failed: count(states.failed),
    obsolete: count(states.obsolete),
    cancelled: count(states.cancelled),
  };
}

export async function readEvaluationTally(
  db: Database,
  scope: EvaluationScope,
) {
  const { state, where, query } = reads(scope);
  const [row] = await query(db, tallyColumns(state)).where(where);
  if (!row) throw new Error("Evaluation tally returned no row");
  return { ...row, pending: row.queued + row.resultReady };
}
export type EvaluationTally = Awaited<ReturnType<typeof readEvaluationTally>>;

const outcomeReceipt = z.object({
  outcome: z.string(),
  diagnostics: z
    .array(
      z.object({
        targetId: z.string(),
        stage: z.enum(["apply", "paired_model"]),
        reason: z.string(),
      }),
    )
    .optional(),
});

/**
 * State counts, outcome counts and every diagnostic. A settling step takes its final tallies
 * from this, so it is one statement: a concurrent settlement is seen in full or not at all, and
 * no outcome can be missed by a read that also finds nothing pending. Only receipts with
 * diagnostics leave the database, in roster order, and the receipt schema decides if one counts.
 */
export async function readEvaluationOutcomes(
  db: Database,
  scope: EvaluationScope,
) {
  const { state, receipt, where, order, query } = reads(scope);
  const hasDiagnostics = sql`(jsonb_typeof(${receipt}) = 'object'
    AND ${receipt} ? 'diagnostics' AND ${receipt} -> 'diagnostics' <> '[]'::jsonb)`;
  const plainOutcome = (value: string) => sql<number>`(count(*) FILTER (WHERE
    jsonb_typeof(${receipt}) = 'object' AND ${receipt} -> 'outcome' = to_jsonb(${value}::text)
    AND NOT coalesce(${hasDiagnostics}, false)))::int`;
  const [row] = await query(db, {
    ...tallyColumns(state),
    plainApplied: plainOutcome("applied"),
    plainQueued: plainOutcome("queued"),
    detailed: sql<
      unknown[] | null
    >`jsonb_agg(${receipt} ORDER BY ${sql.join(order, sql`, `)})
      FILTER (WHERE ${hasDiagnostics})`,
  }).where(where);
  if (!row) throw new Error("Evaluation outcomes returned no row");
  const { plainApplied, plainQueued, detailed, ...tally } = row;
  const parsed = (detailed ?? []).flatMap((receipt) => {
    const result = outcomeReceipt.safeParse(receipt);
    return result.success ? [result.data] : [];
  });
  const outcome = (value: string) =>
    parsed.filter((entry) => entry.outcome === value).length;
  return {
    tally: { ...tally, pending: tally.queued + tally.resultReady },
    applied: plainApplied + outcome("applied"),
    queued: plainQueued + outcome("queued"),
    diagnostics: parsed.flatMap((entry) => entry.diagnostics ?? []),
  };
}

/**
 * Every failed evaluation's identity, with the message only for the newest sample a step
 * stores: `recordRunStepPage` keeps all refs but only that many errors. Read once, at settle.
 */
export async function readFailedEvaluations(
  db: Database,
  scope: EvaluationScope,
) {
  const { state, error, where, order, query } = reads(scope);
  const descending = sql.join(
    order.map((column) => sql`${column} DESC`),
    sql`, `,
  );
  return query(db, {
    id: aiEvaluation.id,
    updatedAt: aiEvaluation.updatedAt,
    error: sql<string | null>`(CASE
      WHEN row_number() OVER (ORDER BY ${descending}) <= ${RUN_STEP_ERROR_SAMPLE}
      THEN ${error} END)`,
  })
    .where(and(where, sql`${state} = ${aiEvaluationState.enum.failed}`))
    .orderBy(...order);
}

/** The first non-empty errors, for progress that shows a few. */
export async function readFirstEvaluationErrors(
  db: Database,
  scope: EvaluationScope,
  limit: number,
): Promise<string[]> {
  const { error, where, order, query } = reads(scope);
  const rows = await query(db, { error })
    .where(and(where, sql`${error} <> ''`))
    .orderBy(...order)
    .limit(limit);
  return rows.flatMap((row) => (row.error ? [row.error] : []));
}

/** All non-empty errors, one per line, for a settling Run's diagnostic. */
export async function readEvaluationErrorText(
  db: Database,
  scope: EvaluationScope,
): Promise<string | null> {
  const { error, where, order, query } = reads(scope);
  const [row] = await query(db, {
    text: sql<
      string | null
    >`string_agg(${error}, ${"\n"} ORDER BY ${sql.join(order, sql`, `)})
      FILTER (WHERE ${error} <> '')`,
  }).where(where);
  return row?.text ?? null;
}
