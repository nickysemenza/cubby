import { aiExecutionKind } from "@cubby/schemas/ai-evaluation";
import { buildActorContext, systemActor } from "@cubby/schemas/context";
import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import {
  sweepFamilyScope,
  sweepRunInput,
  type SweepFamily,
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import type { RunStepError } from "@cubby/schemas/run-step";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { reviveRunAiEvaluationWork } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import {
  readEvaluationOutcomes,
  readEvaluationTally,
  readFailedEvaluations,
  type EvaluationScope,
  type EvaluationTally,
} from "~/server/ai/evaluation/repo/evaluation-tally";
import type { Database } from "~/server/db";
import {
  countStatementPendingHolds,
  countSuggestionsNeedingLabels,
  countUnmatchedCharges,
  generateStatementHoldVoidPage,
  generateStatementSuggestionPage,
  retryStatementGenerationRefs,
  statementChargeFromWorkRef,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { buildCrudServices } from "~/server/http/request-context";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { ensureRun } from "../repo/ensure-run";
import { activeSweepFor, type StepRunOwner } from "../repo/run-step";
import type { StepDriversFor } from "./run-step-registry";
import { pageRetryRefs, type StepContext, type StepPage } from "./step-run";

/**
 * Starts a Sweep: the declared steps of each family in scope, run by the
 * universal Job. A scheduled Sweep that found nothing ends routine.
 */
export async function startSweep(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  input: {
    trigger: "manual" | "scheduled";
    families: readonly SweepFamilyScope[];
  },
) {
  const runId = await ensureRun(db, actor, {
    purpose: "sweep",
    trigger: input.trigger,
    status: "running",
    input: sweepRunInput.parse({ kind: "sweep", families: input.families }),
  });
  await launchWorkflowRun(db, { runId, purpose: "sweep" });
  return runId;
}

/**
 * The automatic pass over one whole family: a routine Sweep, unless one
 * covering that family is already unfinished.
 */
export async function startRoutineSweep(
  db: Database,
  family: SweepFamilyScope["family"],
) {
  if (await activeSweepFor(db, family)) return null;
  return startSweep(db, systemActor(), {
    trigger: "scheduled",
    families: [sweepFamilyScope.parse({ family, scope: {} })],
  });
}

/**
 * What a Sweep would look at: each family's first counted step, the same
 * COUNT that step freezes when it starts. Nothing runs.
 */
export async function estimateSweep(
  db: Database,
  families: readonly SweepFamilyScope[],
) {
  const boundary = new Date().toISOString();
  return Promise.all(
    families.map(async (entry) => ({
      family: entry.family,
      records: await countFamilyInput(db, entry, boundary),
    })),
  );
}

type FamilyScope<F extends SweepFamily> = Extract<
  SweepFamilyScope,
  { family: F }
>["scope"];

/** The scope a Sweep's input gave one family. */
function scopeOf<F extends SweepFamily>(
  run: StepRunOwner,
  family: F,
): FamilyScope<F> {
  const entry = sweepRunInput
    .parse(run.input)
    .families.find((candidate) => candidate.family === family);
  if (!entry) throw new Error(`This Sweep does not cover ${family}`);
  // SAFETY: the discriminant matched, so the scope is this family's.
  return entry.scope as FamilyScope<F>;
}

/** Each family's first counted step: its frozen COUNT and the Sweep estimate. */
const familyInputCount = {
  // Charges are derived from current statement rows, so no cutoff bounds
  // them: a charge that stops qualifying mid-step is tallied `removed`.
  statement_transaction: (db, scope) => countUnmatchedCharges(db, scope),
  // Targets come from the Sweep's own input, a closed population.
  field: async (_db, scope) => fieldTargets(scope.targets).length,
} satisfies {
  [F in SweepFamily]: (
    db: Database,
    scope: FamilyScope<F>,
    boundary: string,
  ) => Promise<number>;
};

const countFamilyInput = (
  db: Database,
  entry: SweepFamilyScope,
  boundary: string,
) =>
  // SAFETY: the entry's discriminant selects the counter for its own scope.
  (
    familyInputCount[entry.family] as (
      db: Database,
      scope: SweepFamilyScope["scope"],
      boundary: string,
    ) => Promise<number>
  )(db, entry.scope, boundary);

/** A label pass keeps its model-funding pause on the step. */
const budgetPause = (error: unknown): StepPage | null =>
  error instanceof AiBudgetExhaustedError
    ? {
        kind: "paused",
        reason: error.message,
        until: new Date(error.resumeAt),
        waitReason: "ai_funding_window",
      }
    : null;

const waitFor = (until: number | null) =>
  until === null
    ? {}
    : { waitSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1_000)) };

const labelsOff = {
  meta: { detail: { labels: "off: automatic AI work is disabled" } },
};

// ---- Statements: match charges, recheck vanished holds, then label. ----

const statementCursor = z
  .object({
    after: z.object({ source: z.string(), chargeKey: z.string() }).nullable(),
  })
  .nullable();

const statementGenerate: StepDriversFor<"sweep">["statement_generate"] = {
  count: async ({ db, run }) => ({
    total: await familyInputCount.statement_transaction(
      db,
      scopeOf(run, "statement_transaction"),
    ),
    boundary: null,
  }),
  page: async (context) => {
    const { db, run, step, work } = context;
    const scope = scopeOf(run, "statement_transaction");
    const limit = scope.importId
      ? JOB_PAGE_LIMITS.statementApplicationsPerPage
      : JOB_PAGE_LIMITS.statementGenerationPerPage;
    const retried = await pageRetryRefs(context, limit, async (refs) => {
      const outcome = await retryStatementGenerationRefs(db, {
        servicesFor: buildCrudServices,
        runId: run.id,
        scope,
        refs,
        work,
      });
      return {
        delta: {
          done: outcome.done,
          skipped: outcome.skipped,
          failed: outcome.failed.length,
        },
        errors: outcome.failed,
        tallies: {
          published: outcome.published,
          labelsReused: outcome.labelsReused,
        },
        reasons: {
          unchanged: outcome.unchanged,
          out_of_scope: outcome.skipped,
        },
      };
    });
    if (retried) return retried;
    const cursor = statementCursor.parse(step.cursor ?? null) ?? {
      after: null,
    };
    // Optional model preparation belongs to statement_label; it must never hold
    // an already published generation page behind an unrelated provider/SQL wait.
    const page = await generateStatementSuggestionPage(db, {
      servicesFor: buildCrudServices,
      limit,
      after: cursor.after,
      runId: run.id,
      scope,
      work,
    });
    return {
      kind: "progress",
      delta: {
        done: Math.max(
          0,
          page.processed - page.outOfScope - page.failed.length,
        ),
        skipped: page.outOfScope,
        failed: page.failed.length,
      },
      errors: page.failed,
      tallies: {
        published: page.published,
        labelsReused: page.labelsReused,
      },
      reasons: { out_of_scope: page.outOfScope, unchanged: page.unchanged },
      cursor: page.next
        ? {
            after: page.next,
          }
        : null,
      done: page.next === null,
    };
  },
};

const statementHolds: StepDriversFor<"sweep">["statement_holds"] = {
  count: async ({ db, run }) => ({
    total: await countStatementPendingHolds(
      db,
      scopeOf(run, "statement_transaction"),
    ),
    boundary: null,
  }),
  page: async ({ db, run, step }) => {
    const page = await generateStatementHoldVoidPage(db, {
      after: z
        .string()
        .nullable()
        .parse(step.cursor ?? null),
      runId: run.id,
      scope: scopeOf(run, "statement_transaction"),
      limit: JOB_PAGE_LIMITS.suggestionsPerPage,
    });
    return {
      kind: "progress",
      delta: {
        done: Math.max(0, page.processed - page.failed.length),
        failed: page.failed.length,
      },
      errors: page.failed,
      tallies: { published: page.published },
      reasons: { unchanged: page.unchanged },
      cursor: page.next,
      done: page.next === null,
    };
  },
};

const statementLabel: StepDriversFor<"sweep">["statement_label"] = {
  count: async ({ db, run }) => ({
    total: await countSuggestionsNeedingLabels(
      db,
      scopeOf(run, "statement_transaction"),
    ),
    boundary: null,
  }),
  page: async ({ db, run, step, retrying, work }) => {
    const { labelStatementSuggestions } =
      await import("~/server/domains/transaction-import/service/statement-suggestion-labels");
    const retryRefs = step.meta?.retryRefs ?? [];
    const retainedRetry = retrying || retryRefs.length > 0;
    const ref = retryRefs[0];
    const scope = scopeOf(run, "statement_transaction");
    if (retainedRetry && !ref)
      return {
        kind: "progress",
        delta: { failed: 1 },
        errors: [
          {
            at: new Date().toISOString(),
            message:
              "Statement label retry has no retained charge references. Inspect the failed step before restarting its scope.",
          },
        ],
        done: true,
      };
    const charge = ref ? statementChargeFromWorkRef(ref) : null;
    let outcome: Awaited<ReturnType<typeof labelStatementSuggestions>>;
    try {
      if (ref) {
        // One charge stays retained across model waits; never reset the population cursor.
        const refreshed = await retryStatementGenerationRefs(db, {
          servicesFor: buildCrudServices,
          runId: run.id,
          scope,
          refs: [ref],
          work,
        });
        if (!refreshed.done) {
          const remaining = retryRefs.filter((candidate) => candidate !== ref);
          return {
            kind: "progress",
            delta: {
              skipped: refreshed.skipped,
              failed: refreshed.failed.length,
            },
            errors: refreshed.failed,
            meta: { retryRefs: remaining },
            done: remaining.length === 0,
          };
        }
      }
      outcome = await labelStatementSuggestions(db, {
        runId: run.id,
        cooperative: true,
        work,
        countedFailures: new Set(step.meta?.failedRefs ?? []),
        after: retainedRetry
          ? null
          : z
              .object({
                createdAt: z.string(),
                id: z.string(),
                inclusive: z.boolean().optional(),
              })
              .nullable()
              .parse(step.cursor ?? null),
        scope,
        ...(retainedRetry && { retryCharges: charge ? [charge] : [] }),
      });
    } catch (error) {
      const paused = budgetPause(error);
      if (paused) return paused;
      throw error;
    }
    if (retainedRetry) {
      const tallies = {
        labelsReused: outcome.labels.reused,
        labelsGenerated: outcome.labels.generated,
      };
      if (outcome.paused)
        return {
          kind: "paused",
          tallies,
          reason: outcome.paused.reason,
          until: new Date(outcome.paused.until),
          waitReason: "ai_funding_window",
        };
      if (!outcome.active)
        return {
          kind: "paused",
          tallies,
          reason:
            "Automatic AI work is disabled; retained statement labels are waiting.",
          until: null,
        };
      const failed = outcome.failed.length > 0;
      const pending = !failed && (outcome.next !== null || outcome.stale > 0);
      const remaining = pending
        ? retryRefs
        : retryRefs.filter((candidate) => candidate !== ref);
      return {
        kind: "progress",
        delta: {
          done: pending || failed ? 0 : 1,
          failed: outcome.failed.length,
        },
        errors: outcome.failed,
        tallies,
        meta: { retryRefs: remaining },
        done: remaining.length === 0,
        ...(pending ? { waitSeconds: 1 } : {}),
        ...waitFor(outcome.waitingUntil),
      };
    }
    const checkpoint = {
      delta: {
        done: outcome.completed,
        skipped: outcome.stale,
        failed: outcome.failed.length,
      },
      errors: outcome.failed,
      tallies: {
        labelsReused: outcome.labels.reused,
        labelsGenerated: outcome.labels.generated,
      },
      cursor: outcome.next,
    };
    if (outcome.paused)
      return {
        ...checkpoint,
        kind: "paused",
        reason: outcome.paused.reason,
        until: new Date(outcome.paused.until),
        waitReason: "ai_funding_window",
      };
    return {
      ...checkpoint,
      kind: "progress",
      ...(!outcome.active && labelsOff),
      done: outcome.next === null,
      ...waitFor(outcome.waitingUntil),
    };
  },
};

// ---- AI evaluations a Sweep step fans out to per-item Jobs and waits on. ----

const EVALUATION_WAIT_SECONDS = 30;

const fieldEvaluations = (run: StepRunOwner): EvaluationScope => ({
  runId: run.id,
  source: "requested",
  executionKind: aiExecutionKind.enum.suggestion_sweep,
});

/**
 * One wait page over the evaluations a roster queued: their states are the
 * step's absolute counts, so a re-read never adds them twice.
 */
async function evaluationPage(
  context: StepContext,
  scope: EvaluationScope,
  tally: EvaluationTally,
  extra: Pick<Extract<StepPage, { kind: "progress" }>, "tallies" | "reasons">,
): Promise<StepPage> {
  const { step } = context;
  const { pending, total, completed, failed } = tally;
  const skipped = tally.blocked + tally.obsolete + tally.cancelled;
  // This Run is running and still waits, so nothing it waits on may stay parked.
  if (pending) await reviveRunAiEvaluationWork(context.db, context.run.id);
  // Errors are the newest-first sample; only a settled step records them.
  const errors: RunStepError[] =
    !pending && failed
      ? (await readFailedEvaluations(context.db, scope)).map((item) => ({
          at: item.updatedAt.toISOString(),
          message: item.error ?? "AI evaluation failed",
          ref: `evaluation:${item.id}`,
        }))
      : [];
  return {
    kind: "progress",
    delta: {
      done: completed - step.done,
      failed: failed - step.failed,
      skipped: skipped - step.skipped,
    },
    ...(errors.length && { errors }),
    ...extra,
    absolute: true,
    ...(pending && {
      action: `Waiting for ${pending} of ${total} evaluations`,
    }),
    ...(pending && { waitSeconds: EVALUATION_WAIT_SECONDS }),
    done: pending === 0,
  };
}

/** "Retry failed" on an evaluate step re-admits each failed evaluation once. */
async function readmitFailures(context: StepContext, owned: boolean) {
  if (!context.retrying) return;
  const { readmitFailedAiWork } =
    await import("~/server/workflows/runs/control");
  await readmitFailedAiWork(context.db, context.run.id, {
    owned,
    requested: !owned,
    attempt: context.attempt,
  });
}

// ---- Fields: roster each entity's decision fields, then wait. ----

/** The entity × decision-field targets a field Sweep covers. */
function fieldTargets(
  targets?: Extract<SweepFamilyScope, { family: "field" }>["scope"]["targets"],
) {
  if (targets?.length) return targets;
  const byEntity = new Map<string, string[]>();
  for (const key of suggestFieldKeys) {
    const [entity = "", field = ""] = key.split(".");
    byEntity.set(entity, [...(byEntity.get(entity) ?? []), field]);
  }
  return [...byEntity].map(([entity, fields]) => ({
    entity,
    fields,
    filters: {},
  }));
}

const fieldRoster: StepDriversFor<"sweep">["field_roster"] = {
  count: async ({ db, run }) => ({
    total: await familyInputCount.field(db, scopeOf(run, "field")),
    boundary: null,
  }),
  page: async ({ db, run, step }) => {
    const targets = fieldTargets(scopeOf(run, "field").targets);
    const index = z
      .number()
      .int()
      .nonnegative()
      .parse(step.cursor ?? 0);
    const target = targets[index];
    if (!target) return { kind: "progress", done: true };
    const { rosterSuggestionTargets, suggestionSweepInput } =
      await import("./suggestion-sweep");
    const context = {
      ...buildCrudServices(db),
      actorContext: buildActorContext(run.actorUserId, run.channel, {
        oauthClientId: run.oauthClientId,
        deviceId: run.deviceId,
        runId: run.id,
      }),
    };
    const input = await suggestionSweepInput(db, {
      entity: z.enum(shortcodeEntities).parse(target.entity),
      fields: target.fields,
      filters: z.record(z.string(), z.json()).parse(target.filters),
    });
    const queued = await rosterSuggestionTargets(db, run.id, input, {
      context,
    });
    return {
      kind: "progress",
      delta: { done: 1 },
      tallies: { evaluations: queued },
      cursor: index + 1,
      done: index + 1 >= targets.length,
    };
  },
};

const fieldEvaluate: StepDriversFor<"sweep">["field_evaluate"] = {
  count: async ({ db, run }) => ({
    total: (await readEvaluationTally(db, fieldEvaluations(run))).total,
    boundary: null,
  }),
  page: async (context) => {
    await readmitFailures(context, false);
    const scope = fieldEvaluations(context.run);
    const outcomes = await readEvaluationOutcomes(context.db, scope);
    const reasons: Record<string, number> = {};
    for (const diagnostic of outcomes.diagnostics)
      reasons[diagnostic.reason] = (reasons[diagnostic.reason] ?? 0) + 1;
    return evaluationPage(context, scope, outcomes.tally, {
      tallies: { applied: outcomes.applied, queued: outcomes.queued },
      reasons,
    });
  },
};

export const sweepStepDrivers = {
  statement_generate: statementGenerate,
  statement_holds: statementHolds,
  statement_label: statementLabel,
  field_roster: fieldRoster,
  field_evaluate: fieldEvaluate,
} satisfies StepDriversFor<"sweep">;
