import { type RunId } from "@cubby/schemas/identifiers";
import { jobState } from "@cubby/schemas/job";
import {
  RUN_STEP_ERROR_SAMPLE,
  runStepErrors,
  runStepState,
  type RunStepCounts,
  type RunStepError,
  type RunStepMeta,
  type RunStepState,
} from "@cubby/schemas/run-step";
import {
  runWorkSamples,
  runWorkSample,
} from "@cubby/schemas/run-work-progress";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb, unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import { run, runStep } from "~/server/db/schema";
import { currentJobExecution } from "~/server/generic/jobs/context";
import {
  assertWorkflowEffect,
  hasWorkflowExecution,
} from "~/server/workflows/runs/execution";

export type RunStepRow = typeof runStep.$inferSelect;
export type StepRunOwner = typeof run.$inferSelect;
export type RunStepDefinition = { key: string; label: string };
/** `left` is null for a step without a frozen count (a tally or an estimate). */
export type RunStepRead = RunStepRow & { left: number | null };

/** Creates a Run's ordered steps once; a relaunch keeps every count and cursor. */
export async function ensureRunSteps(
  db: Database,
  runId: RunId,
  steps: readonly RunStepDefinition[],
) {
  if (!steps.length) return;
  await getDb(db)
    .insert(runStep)
    .values(
      steps.map((step, position) => ({
        runId,
        key: step.key,
        label: step.label,
        position,
      })),
    )
    .onConflictDoNothing({ target: [runStep.runId, runStep.key] });
}

export async function listRunSteps(db: Database, runId: RunId) {
  return listRunStepsForRuns(db, [runId]);
}

export async function listRunStepsForRuns(
  db: Database | DrizzleTransaction,
  runIds: RunId[],
) {
  if (!runIds.length) return [];
  return unwrapDb(db)
    .select()
    .from(runStep)
    .where(inArray(runStep.runId, runIds))
    .orderBy(asc(runStep.position));
}

const TERMINAL: readonly RunStepState[] = ["done", "failed"];
export const isTerminalStep = (state: RunStepState) => TERMINAL.includes(state);

/**
 * Moves a queued or paused step to running. `frozen` is the population a
 * step counts once per generation; a resumed or retried step passes null.
 */
export async function startRunStep(
  db: Database,
  runId: RunId,
  key: string,
  frozen: { found: number; input: NonNullable<RunStepMeta["input"]> } | null,
) {
  const write = async (tx: Database) => {
    const [row] = await getDb(tx)
      .update(runStep)
      .set({
        state: "running",
        pausedReason: null,
        pausedUntil: null,
        startedAt: sql`coalesce(${runStep.startedAt}, ${new Date()})`,
        ...(frozen && {
          found: frozen.found,
          meta: sql`coalesce(${runStep.meta}, '{}'::jsonb) || ${JSON.stringify({ input: frozen.input })}::jsonb`,
        }),
      })
      .where(
        and(
          eq(runStep.runId, runId),
          eq(runStep.key, key),
          inArray(runStep.state, ["queued", "paused"]),
        ),
      )
      .returning();
    return row ?? null;
  };
  if (!hasWorkflowExecution()) return write(db);
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    return write(tx);
  });
}

/**
 * Applies one page's outcome in a single statement: counts are increments so a
 * page is recorded once per committed write, errors keep the newest sample.
 */
export async function recordRunStepPage(
  db: Database,
  runId: RunId,
  key: string,
  page: Parameters<typeof writeRunStepPage>[3],
) {
  if (!hasWorkflowExecution()) return writeRunStepPage(db, runId, key, page);
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    return writeRunStepPage(tx, runId, key, page);
  });
}

async function writeRunStepPage(
  db: Database,
  runId: RunId,
  key: string,
  page: {
    delta?: Partial<Omit<RunStepCounts, "found">>;
    errors?: readonly RunStepError[];
    cursor?: unknown;
    state?: RunStepState;
    pausedReason?: string | null;
    pausedUntil?: Date | null;
    meta?: RunStepMeta;
  },
) {
  const delta = page.delta ?? {};
  const failedRefs = (page.errors ?? []).flatMap((error) =>
    error.ref ? [error.ref] : [],
  );
  const errors = page.errors?.length
    ? runStepErrors.parse(
        page.errors.slice(-RUN_STEP_ERROR_SAMPLE).map((error) => ({
          ...error,
          message: scrubErrorMessage(error.message),
        })),
      )
    : null;
  const now = new Date();
  await getDb(db)
    .update(runStep)
    .set({
      done: sql`${runStep.done} + ${delta.done ?? 0}`,
      failed: sql`${runStep.failed} + ${delta.failed ?? 0}`,
      skipped: sql`${runStep.skipped} + ${delta.skipped ?? 0}`,
      pages: sql`${runStep.pages} + 1`,
      ...(errors && {
        errors: sql`(SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb) FROM (SELECT e, ord FROM jsonb_array_elements(${runStep.errors} || ${JSON.stringify(errors)}::jsonb) WITH ORDINALITY AS t(e, ord) ORDER BY ord DESC LIMIT ${RUN_STEP_ERROR_SAMPLE}) newest)`,
      }),
      ...(page.cursor !== undefined && { cursor: page.cursor }),
      ...(page.pausedReason !== undefined && {
        pausedReason: page.pausedReason,
      }),
      ...(page.pausedUntil !== undefined && { pausedUntil: page.pausedUntil }),
      ...((page.meta || failedRefs.length) && {
        meta: sql`coalesce(${runStep.meta}, '{}'::jsonb) || ${JSON.stringify(page.meta ?? {})}::jsonb
          || jsonb_build_object('failedRefs', coalesce(${runStep.meta}->'failedRefs', '[]'::jsonb) || ${JSON.stringify(failedRefs)}::jsonb)`,
      }),
      ...(page.state && {
        state: page.state,
        ...(page.state === "running" && {
          startedAt: sql`coalesce(${runStep.startedAt}, ${now})`,
        }),
        ...(isTerminalStep(page.state) && { endedAt: now }),
      }),
    })
    .where(and(eq(runStep.runId, runId), eq(runStep.key, key)));
}

/** Re-admits a failed step: its failures become work again, counts stay history. */
export async function reopenRunStep(
  db: Database,
  runId: RunId,
  key: string,
): Promise<RunStepRow | null> {
  const workKey = runWorkSamples.keyof().enum;
  const itemKey = runWorkSample.keyof().enum;
  const currentWork = sql`${runStep.meta}->'work'->${workKey.current}`;
  const retryWork = sql`CASE WHEN ${currentWork} IS NULL THEN '{}'::jsonb ELSE
    jsonb_build_object('work', (${runStep.meta}->'work') || jsonb_build_object(${workKey.current}::text, ${currentWork} ||
      jsonb_build_object(${itemKey.finished}::text, false, 'failures', 0,
        'processed', greatest(0, (${currentWork}->>'processed')::int - (${currentWork}->>'failures')::int),
        'sampledAt', ${new Date().toISOString()}::text))) END`;
  const [row] = await getDb(db)
    .update(runStep)
    .set({
      state: "queued",
      failed: 0,
      endedAt: null,
      pausedReason: null,
      pausedUntil: null,
      meta: sql`coalesce(${runStep.meta}, '{}'::jsonb) || jsonb_build_object('capacityUntil', null, 'retriedFailures', coalesce((${runStep.meta}->>'retriedFailures')::int, 0) + ${runStep.failed}, 'retryRefs', coalesce(${runStep.meta}->'failedRefs', '[]'::jsonb), 'failedRefs', '[]'::jsonb) || ${retryWork}`,
      errors: sql`'[]'::jsonb`,
    })
    .where(
      and(
        eq(runStep.runId, runId),
        eq(runStep.key, key),
        sql`(${runStep.failed} > 0 OR ${runStep.state} = ${runStepState.enum.failed})`,
        inArray(runStep.state, ["done", "failed"]),
      ),
    )
    .returning();
  return row ?? null;
}

/** Steps with their derived `left`, in order. */
export async function readRunSteps(
  db: Database,
  runId: RunId,
): Promise<RunStepRead[]> {
  return (await listRunSteps(db, runId)).map((step) => ({
    ...step,
    left: leftOf(step),
  }));
}

export const leftOf = (step: RunStepRow) =>
  step.meta?.input && step.meta.input.mode !== "count"
    ? null
    : Math.max(
        step.found -
          step.done -
          step.failed -
          step.skipped -
          (step.meta?.tallies?.removed ?? 0),
        0,
      );

const attemptIs = (_attempt: number) => {
  const execution = currentJobExecution();
  return execution
    ? sql`EXISTS (SELECT 1 FROM "Job" j WHERE j.id=${execution.claim.id}::uuid AND j.state=${jobState.enum.running} AND j."generation"=${execution.claim.generation} AND j."leaseToken"=${execution.claim.leaseToken}::uuid AND j."leaseExpiresAt">now())`
    : sql`false`;
};

/** Pauses this attempt's Run for a budget or authorization window. */
export async function pauseStepRun(
  db: Database,
  runId: RunId,
  attempt: number,
  reason: string,
) {
  const [paused] = await getDb(db)
    .update(run)
    .set({
      status: "paused_auth",
      failureCode: "execution_limit",
      dispatchError: reason,
    })
    .where(
      and(eq(run.id, runId), eq(run.status, "running"), attemptIs(attempt)),
    )
    .returning({ id: run.id });
  return Boolean(paused);
}

/** Ends this attempt's Run once every step is terminal. */
export async function finishStepRunRow(
  db: Database,
  runId: RunId,
  attempt: number,
  outcome: {
    failedLabels: readonly string[];
    routine: boolean;
  },
) {
  const failed = outcome.failedLabels.length > 0;
  const [finished] = await getDb(db)
    .update(run)
    .set({
      status: failed ? "needs_review" : "completed",
      endedAt: new Date(),
      failureCode: failed ? "step_failures" : null,
      dispatchError: failed
        ? `${outcome.failedLabels.join(", ")} recorded failures`
        : null,
      routine: outcome.routine,
    })
    .where(
      and(eq(run.id, runId), eq(run.status, "running"), attemptIs(attempt)),
    )
    .returning({ id: run.id });
  return Boolean(finished);
}

export async function readStepRunOwner(db: Database, runId: RunId) {
  const [owner] = await getDb(db)
    .select({
      id: run.id,
      purpose: run.purpose,
      status: run.status,
      failureCode: run.failureCode,
    })
    .from(run)
    .where(eq(run.id, runId));
  return owner ?? null;
}

/**
 * An unfinished Sweep that covers this whole family (no scope), if one
 * exists; a member's scoped Sweep never stands in for routine coverage.
 */
export async function activeSweepFor(db: Database, family: string) {
  const [row] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "sweep"),
        inArray(run.status, ["running", "paused_auth"]),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${run.input}->'families') covered
          WHERE covered->>'family' = ${family} AND coalesce(covered->'scope', '{}'::jsonb) = '{}'::jsonb)`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * A restarted routine pass abandons the Run its earlier generation opened;
 * that Run ends with the counts it reached instead of staying open.
 */
export async function endSupersededRoutineRuns(
  db: Database,
  pass: { purpose: string; input: unknown; keep: RunId },
) {
  const ended = await getDb(db)
    .update(run)
    .set({
      status: "completed",
      endedAt: new Date(),
      notes: "Superseded by a newer pass",
    })
    .where(
      and(
        eq(run.purpose, pass.purpose),
        eq(run.status, "running"),
        sql`${run.input} = ${JSON.stringify(pass.input)}::jsonb`,
        sql`${run.id} <> ${pass.keep}`,
      ),
    )
    .returning({ id: run.id });
  if (!ended.length) return;
  await getDb(db)
    .update(runStep)
    .set({
      state: "done",
      endedAt: new Date(),
      meta: sql`coalesce(${runStep.meta}, '{}'::jsonb) || '{"action":null}'::jsonb`,
    })
    .where(
      and(
        inArray(
          runStep.runId,
          ended.map((row) => row.id),
        ),
        inArray(runStep.state, ["queued", "running", "waiting", "paused"]),
      ),
    );
}

/** Another unfinished Run of a purpose that allows only one at a time. */
export async function otherActiveRun(
  db: Database,
  purpose: string,
  runId: RunId,
) {
  const [row] = await getDb(db)
    .select({ shortcode: run.shortcode })
    .from(run)
    .where(
      and(
        eq(run.purpose, purpose),
        inArray(run.status, ["running", "paused_auth"]),
        sql`${run.id} <> ${runId}`,
      ),
    )
    .limit(1);
  return row?.shortcode ?? null;
}
