import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
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
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run, runStep } from "~/server/db/schema";

export type RunStepRow = typeof runStep.$inferSelect;
export type StepRunOwner = typeof run.$inferSelect;
export type RunStepDefinition = { key: string; label: string };
export type RunStepRead = RunStepRow & { left: number };

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
  return getDb(db)
    .select()
    .from(runStep)
    .where(eq(runStep.runId, runId))
    .orderBy(asc(runStep.position));
}

const TERMINAL: readonly RunStepState[] = ["done", "failed"];
export const isTerminalStep = (state: RunStepState) => TERMINAL.includes(state);

/**
 * Applies one page's outcome in a single statement: counts are increments so a
 * page is recorded once per committed write, errors keep the newest sample.
 */
export async function recordRunStepPage(
  db: Database,
  runId: RunId,
  key: string,
  page: {
    delta?: Partial<RunStepCounts>;
    /** Replaces `found` when the driver knows the backlog size. */
    found?: number;
    /**
     * Replaces every count with a child Run's own totals; absolute, so a
     * re-read of the same child never double counts.
     */
    counts?: RunStepCounts;
    errors?: readonly RunStepError[];
    cursor?: unknown;
    state?: RunStepState;
    childRunId?: RunId | null;
    pausedReason?: string | null;
    pausedUntil?: Date | null;
    meta?: RunStepMeta;
  },
) {
  const delta = page.delta ?? {};
  const errors = page.errors?.length
    ? runStepErrors.parse(page.errors.slice(-RUN_STEP_ERROR_SAMPLE))
    : null;
  const now = new Date();
  const counts = page.counts
    ? page.counts
    : {
        found:
          page.found === undefined
            ? sql`${runStep.found} + ${delta.found ?? 0}`
            : page.found,
        done: sql`${runStep.done} + ${delta.done ?? 0}`,
        failed: sql`${runStep.failed} + ${delta.failed ?? 0}`,
        skipped: sql`${runStep.skipped} + ${delta.skipped ?? 0}`,
      };
  await getDb(db)
    .update(runStep)
    .set({
      ...counts,
      pages: sql`${runStep.pages} + 1`,
      ...(errors && {
        errors: sql`(SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb) FROM (SELECT e, ord FROM jsonb_array_elements(${runStep.errors} || ${JSON.stringify(errors)}::jsonb) WITH ORDINALITY AS t(e, ord) ORDER BY ord DESC LIMIT ${RUN_STEP_ERROR_SAMPLE}) newest)`,
      }),
      ...(page.cursor !== undefined && { cursor: page.cursor }),
      ...(page.childRunId !== undefined && { childRunId: page.childRunId }),
      ...(page.pausedReason !== undefined && {
        pausedReason: page.pausedReason,
      }),
      ...(page.pausedUntil !== undefined && { pausedUntil: page.pausedUntil }),
      ...(page.meta && {
        meta: sql`coalesce(${runStep.meta}, '{}'::jsonb) || ${JSON.stringify(page.meta)}::jsonb`,
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
  const [row] = await getDb(db)
    .update(runStep)
    .set({
      state: "queued",
      failed: 0,
      endedAt: null,
      pausedReason: null,
      pausedUntil: null,
      meta: sql`coalesce(${runStep.meta}, '{}'::jsonb) || jsonb_build_object('retriedFailures', coalesce((${runStep.meta}->>'retriedFailures')::int, 0) + ${runStep.failed}, 'retryErrors', ${runStep.errors})`,
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

/** Steps with `left` and the shortcode of the child Run a step delegates to. */
export async function readRunStepsReport(db: Database, runId: RunId) {
  const steps = await readRunSteps(db, runId);
  const childIds = steps.flatMap((step) =>
    step.childRunId ? [step.childRunId] : [],
  );
  const children = childIds.length
    ? await getDb(db)
        .select({ id: run.id, shortcode: run.shortcode })
        .from(run)
        .where(inArray(run.id, childIds))
    : [];
  return steps.map((step) => ({
    ...step,
    childShortcode:
      children.find((child) => child.id === step.childRunId)?.shortcode ?? null,
  }));
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

export const leftOf = (counts: RunStepCounts) =>
  Math.max(counts.found - counts.done - counts.failed - counts.skipped, 0);

/** The step-ledger parent whose step delegates to this Run, if any. */
export async function stepParentOf(db: Database, childRunId: RunId) {
  const [row] = await getDb(db)
    .select({
      runId: runStep.runId,
      key: runStep.key,
      shortcode: run.shortcode,
      purpose: run.purpose,
      status: run.status,
      progress: run.progress,
    })
    .from(runStep)
    .innerJoin(run, eq(run.id, runStep.runId))
    .where(eq(runStep.childRunId, childRunId))
    .limit(1);
  return row ?? null;
}

const attemptIs = (attempt: number) =>
  sql`coalesce((${run.progress}->>'attempt')::int, 0) = ${attempt}`;

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
    .select({ id: run.id, purpose: run.purpose, status: run.status })
    .from(run)
    .where(eq(run.id, runId));
  return owner ?? null;
}

/**
 * Step-ledger Runs a lost handoff or an ended budget window left behind: a
 * `running` Run whose first attempt never started, or a budget pause no step
 * is still waiting out.
 */
export async function stepRunsToRecover(
  db: Database,
  purposes: readonly string[],
  now: Date,
  runIds?: readonly string[],
) {
  return getDb(db)
    .select({ id: run.id, purpose: run.purpose, status: run.status })
    .from(run)
    .where(
      and(
        inArray(run.purpose, [...purposes]),
        runIds
          ? inArray(
              run.id,
              runIds.map((id) => runEntityId.parse(id)),
            )
          : undefined,
        or(
          and(
            eq(run.status, "running"),
            attemptIs(0),
            lte(run.createdAt, new Date(now.getTime() - 60_000)),
          ),
          and(
            eq(run.status, "paused_auth"),
            eq(run.failureCode, "execution_limit"),
            notExists(
              getDb(db)
                .select({ id: runStep.id })
                .from(runStep)
                .where(
                  and(
                    eq(runStep.runId, run.id),
                    eq(runStep.state, "paused"),
                    gt(runStep.pausedUntil, now),
                  ),
                ),
            ),
          ),
        ),
      ),
    );
}
