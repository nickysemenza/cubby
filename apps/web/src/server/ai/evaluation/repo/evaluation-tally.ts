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
} from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { suggestionSweepRunProgress } from "@cubby/schemas/run-fields";
import { RUN_STEP_ERROR_SAMPLE } from "@cubby/schemas/run-step";
import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest } from "~/server/db/schema";

export type EvaluationScope = { runId: RunId } & (
  | { source: "owned"; connectionsOnly?: boolean }
  | { source: "requested"; executionKind?: string }
);

const UUID_PATTERN = z.regexes.uuid().source;
const uuidString = (value: SQLWrapper) =>
  sql`(jsonb_typeof(${value}) = 'string' AND (${value} #>> '{}') ~ ${UUID_PATTERN})`;

const connectionTarget = () => {
  const field = (key: string) => sql`(${aiEvaluation.target} -> ${key}::text)`;
  return sql`(${field("kind")} = to_jsonb(${aiEvaluationTargetKind.enum.connection}::text)
    AND jsonb_typeof(${field("entity")}) = 'string'
    AND ${uuidString(field("recordId"))}
    AND jsonb_typeof(${field("field")}) = 'null'
    AND ${field("assessmentIds")} = '[]'::jsonb)`;
};

/** A cancelled request hides a falsy receipt; otherwise its own receipt wins over the shared one. */
const requestedReceipt = () => sql`(CASE
  WHEN ${aiEvaluationRequest.cancelledAt} IS NOT NULL
    AND (${aiEvaluationRequest.receipt} IS NULL
      OR ${aiEvaluationRequest.receipt} IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb))
  THEN NULL
  ELSE coalesce(NULLIF(${aiEvaluationRequest.receipt}, 'null'::jsonb), ${aiEvaluation.receipt})
END)`;

function reads(scope: EvaluationScope) {
  const owned = scope.source === "owned";
  const state = owned
    ? sql`${aiEvaluation.state}`
    : sql`(CASE WHEN ${aiEvaluationRequest.cancelledAt} IS NOT NULL
        THEN ${aiEvaluationState.enum.cancelled} ELSE ${aiEvaluation.state} END)`;
  const receipt = owned ? sql`${aiEvaluation.receipt}` : requestedReceipt();
  const error = owned
    ? sql<string | null>`${aiEvaluation.error}`
    : sql<
        string | null
      >`(CASE WHEN ${aiEvaluationRequest.cancelledAt} IS NOT NULL
        THEN ${"Cancelled by a member"} ELSE ${aiEvaluation.error} END)`;
  const retried = sql`(jsonb_typeof(${receipt}) = 'object'
    AND ${uuidString(sql`(${receipt} -> 'retryEvaluationId')`)})`;
  return {
    state,
    receipt,
    error,
    order: owned
      ? [aiEvaluation.createdAt, aiEvaluation.id]
      : [aiEvaluationRequest.sequence, aiEvaluationRequest.id],
    where: and(
      owned
        ? eq(aiEvaluation.runId, scope.runId)
        : eq(aiEvaluationRequest.runId, scope.runId),
      owned
        ? scope.connectionsOnly
          ? connectionTarget()
          : undefined
        : scope.executionKind
          ? sql`${aiEvaluation.executionKind} = ${scope.executionKind}`
          : undefined,
      sql`NOT coalesce(${retried}, false)`,
    ),
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

export async function readEvaluationTally(
  db: Database,
  scope: EvaluationScope,
) {
  const { state, where, query } = reads(scope);
  const count = (value: string) =>
    sql<number>`(count(*) FILTER (WHERE ${state} = ${value}))::int`;
  const { enum: states } = aiEvaluationState;
  const [row] = await query(db, {
    total: sql<number>`count(*)::int`,
    queued: count(states.queued),
    resultReady: count(states.result_ready),
    completed: count(states.completed),
    blocked: count(states.blocked),
    failed: count(states.failed),
    obsolete: count(states.obsolete),
    cancelled: count(states.cancelled),
  }).where(where);
  if (!row) throw new Error("Evaluation tally returned no row");
  return { ...row, pending: row.queued + row.resultReady };
}
export type EvaluationTally = Awaited<ReturnType<typeof readEvaluationTally>>;

const outcomeReceipt = z.object({
  outcome: z.string(),
  diagnostics: suggestionSweepRunProgress.shape.diagnostics.optional(),
});

/**
 * Outcome counts and every diagnostic. Only receipts with diagnostics leave the database,
 * in roster order, and the receipt schema still decides whether one counts.
 */
export async function readEvaluationOutcomes(
  db: Database,
  scope: EvaluationScope,
) {
  const { receipt, where, order, query } = reads(scope);
  const hasDiagnostics = sql`(${receipt} ? 'diagnostics' AND ${receipt} -> 'diagnostics' <> '[]'::jsonb)`;
  const plainOutcome = (value: string) => sql<number>`(count(*) FILTER (WHERE
    jsonb_typeof(${receipt}) = 'object' AND ${receipt} -> 'outcome' = to_jsonb(${value}::text)
    AND NOT coalesce(${hasDiagnostics}, false)))::int`;
  const [plain] = await query(db, {
    applied: plainOutcome("applied"),
    queued: plainOutcome("queued"),
  }).where(where);
  const detailed = await query(db, { receipt: sql<unknown>`${receipt}` })
    .where(and(where, sql`jsonb_typeof(${receipt}) = 'object'`, hasDiagnostics))
    .orderBy(...order);
  const parsed = detailed.flatMap((row) => {
    const result = outcomeReceipt.safeParse(row.receipt);
    return result.success ? [result.data] : [];
  });
  const outcome = (value: string) =>
    parsed.filter((entry) => entry.outcome === value).length;
  return {
    applied: (plain?.applied ?? 0) + outcome("applied"),
    queued: (plain?.queued ?? 0) + outcome("queued"),
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
