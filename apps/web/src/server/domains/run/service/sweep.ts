import { aiEvaluationTarget } from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import {
  suggestionSweepRunProgress,
  sweepFamilyScope,
  sweepRunInput,
  type SweepFamily,
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import type { RunStepError } from "@cubby/schemas/run-step";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import {
  PENDING_AI_STATES,
  requestedAiEvaluations,
} from "~/server/ai/repo/ai-evaluation-requests";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  countTransferPairSeeds,
  countTransferPairStates,
  countTransferPairsNeedingLabels,
  discoverTransferPairs,
  generateTransferPairSuggestionsPage,
  retryTransferPairRefs,
  transferPairGenerationCursor,
  transferPairNeedsLabels,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import {
  countStatementPendingHolds,
  countSuggestionsNeedingLabels,
  countUnmatchedCharges,
  generateStatementHoldVoidPage,
  generateStatementSuggestionPage,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { buildCrudServices } from "~/server/http/request-context";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { aiEvaluationsForRun } from "../repo/ai-work-state";
import {
  countConnectionSweepSources,
  prepareConnectionSweepPage,
} from "../repo/connection-refresh";
import { ensureRun, systemActor } from "../repo/ensure-run";
import { activeSweepFor, type StepRunOwner } from "../repo/run-step";
import type { StepDriversFor } from "./run-step-registry";
import type { StepContext, StepCounter, StepPage } from "./step-run";

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

/** What a Sweep would look at, from stored state; nothing runs. */
export async function estimateSweep(
  db: Database,
  families: readonly SweepFamilyScope[],
) {
  return Promise.all(
    families.map(async (entry) => {
      switch (entry.family) {
        case "transfer_pair": {
          const pairs = await discoverTransferPairs(db, entry.scope);
          return {
            family: entry.family,
            records: pairs.length,
            decisions: pairs.filter(transferPairNeedsLabels).length * 2,
          };
        }
        case "statement_transaction": {
          const charges = await countUnmatchedCharges(db, entry.scope);
          return {
            family: entry.family,
            records: charges,
            // Every charge is matched by rule; labels ask the decision model.
            decisions: await countSuggestionsNeedingLabels(
              db,
              entry.scope.importId ?? null,
            ),
          };
        }
        case "recommendation": {
          const sources = await countConnectionSweepSources(
            db,
            entry.scope.entityKinds,
          );
          return { family: entry.family, records: sources, decisions: sources };
        }
        case "field": {
          const fields = fieldTargets(entry.scope.targets).reduce(
            (total, target) => total + target.fields.length,
            0,
          );
          return { family: entry.family, records: fields, decisions: fields };
        }
      }
    }),
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

/** A frozen boundary is the instant the step counted its population. */
const cutoff = (context: StepContext) =>
  z.iso.datetime().nullable().parse(context.boundary);
const countedNow: (
  count: (context: StepContext, boundary: string) => Promise<number>,
) => StepCounter = (count) => async (context) => {
  const boundary = new Date().toISOString();
  return { total: await count(context, boundary), boundary };
};

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

// ---- Transfer pairs: scan movements, retire stale pairs, label pairs. ----

const scanCursor = transferPairGenerationCursor.nullable();
const labelCursor = z
  .object({ createdAt: z.string(), id: z.string() })
  .nullable();

const transferPairScan: StepDriversFor<"sweep">["transfer_pair_scan"] = {
  count: countedNow((context, boundary) =>
    countTransferPairSeeds(context.db, {
      since: scopeOf(context.run, "transfer_pair").since ?? null,
      createdBefore: boundary,
    }),
  ),
  page: async (context) => {
    const { db, run, step } = context;
    const scope = scopeOf(run, "transfer_pair");
    if (context.retrying) {
      const retried = await retryTransferPairRefs(db, {
        runId: run.id,
        scope,
        refs: step.meta?.retryRefs ?? [],
      });
      return {
        kind: "progress",
        delta: { done: retried.done, failed: retried.failed.length },
        errors: retried.failed,
        meta: { retryRefs: [] },
        done: true,
      };
    }
    const page = await generateTransferPairSuggestionsPage(db, {
      runId: run.id,
      scope,
      after: scanCursor.parse(step.cursor ?? null),
      createdBefore: cutoff(context),
    });
    const seedFailures = page.failed.filter((failure) =>
      failure.ref?.startsWith("transfer_pair_seed:"),
    ).length;
    // A scan ends where the retire step's population begins.
    const done = page.next === null || page.next.kind === "retire";
    return {
      kind: "progress",
      delta: {
        done: page.seeds - seedFailures,
        failed: page.failed.length,
      },
      errors: page.failed,
      tallies: { pairs: page.found, published: page.published },
      reasons: page.reasons,
      cursor: done ? null : page.next,
      done,
    };
  },
};

const transferPairRetire: StepDriversFor<"sweep">["transfer_pair_retire"] = {
  count: countedNow((context, boundary) =>
    countTransferPairStates(context.db, {
      scope: scopeOf(context.run, "transfer_pair"),
      createdBefore: boundary,
    }),
  ),
  page: async (context) => {
    const { db, run, step } = context;
    const after = z
      .object({ createdAt: z.string(), id: z.string() })
      .nullable()
      .parse(step.cursor ?? null);
    const page = await generateTransferPairSuggestionsPage(db, {
      runId: run.id,
      scope: scopeOf(run, "transfer_pair"),
      after: { kind: "retire", after },
      createdBefore: cutoff(context),
    });
    return {
      kind: "progress",
      delta: {
        done: page.processed - page.failed.length,
        failed: page.failed.length,
      },
      errors: page.failed,
      tallies: { retired: page.retired },
      reasons: page.reasons,
      cursor: page.next?.kind === "retire" ? page.next.after : null,
      done: page.next === null,
    };
  },
};

const transferPairLabel: StepDriversFor<"sweep">["transfer_pair_label"] = {
  count: async ({ db, run }) => ({
    total: await countTransferPairsNeedingLabels(db, { runId: run.id }),
    // The scan already finished; this Run's pairs are its whole population.
    boundary: null,
  }),
  page: async ({ db, run, step, retrying }) => {
    const { labelTransferPairSuggestions } =
      await import("~/server/domains/financial-transaction/service/transfer-pair-labels");
    let outcome: Awaited<ReturnType<typeof labelTransferPairSuggestions>>;
    try {
      outcome = await labelTransferPairSuggestions(db, {
        runId: run.id,
        after: retrying ? null : labelCursor.parse(step.cursor ?? null),
        cooperative: true,
      });
    } catch (error) {
      const paused = budgetPause(error);
      if (paused) return paused;
      throw error;
    }
    return {
      kind: "progress",
      delta: {
        done: outcome.completed,
        skipped: outcome.stale,
        failed: outcome.failed.length,
      },
      errors: outcome.failed,
      ...(!outcome.active && labelsOff),
      cursor: outcome.next,
      done: outcome.next === null && outcome.waitingUntil === null,
      ...waitFor(outcome.waitingUntil),
    };
  },
};

// ---- Statements: match charges, recheck vanished holds, then label. ----

const statementCursor = z
  .object({
    after: z.object({ source: z.string(), chargeKey: z.string() }).nullable(),
    precomputedAfter: z
      .object({
        createdAt: z.string(),
        id: z.string(),
        inclusive: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    speculativeUntil: z.number().nullable().optional(),
  })
  .nullable();

const statementGenerate: StepDriversFor<"sweep">["statement_generate"] = {
  // Charges are derived from current statement rows, so no cutoff bounds
  // them: a charge that stops qualifying mid-step is tallied `removed`.
  count: async ({ db, run }) => ({
    total: await countUnmatchedCharges(
      db,
      scopeOf(run, "statement_transaction"),
    ),
    boundary: null,
  }),
  page: async ({ db, run, step }) => {
    const scope = scopeOf(run, "statement_transaction");
    const cursor = statementCursor.parse(step.cursor ?? null) ?? {
      after: null,
    };
    const generation = generateStatementSuggestionPage(db, {
      limit: JOB_PAGE_LIMITS.suggestionsPerPage,
      after: cursor.after,
      runId: run.id,
      scope,
    });
    // Labels the next step needs are computed while generation waits on I/O.
    const { precomputeStatementSuggestionLabels } =
      await import("~/server/domains/transaction-import/service/statement-suggestion-labels");
    const speculative =
      (cursor.speculativeUntil ?? 0) > Date.now()
        ? Promise.resolve(null)
        : precomputeStatementSuggestionLabels(db, {
            runId: run.id,
            importId: scope.importId ?? null,
            cooperative: true,
            after: cursor.precomputedAfter ?? null,
            maxBytes: 2 * 1024 * 1024,
            maxMs: 5_000,
            beforeCheckpoint: async () => {
              await generation;
            },
          });
    const [generated, computed] = await Promise.allSettled([
      generation,
      speculative,
    ]);
    if (generated.status === "rejected") throw generated.reason;
    if (
      computed.status === "rejected" &&
      (await import("~/server/workflows/runs/execution")).isWorkflowInterrupted(
        computed.reason,
      )
    )
      throw computed.reason;
    const page = generated.value;
    const precompute = computed.status === "fulfilled" ? computed.value : null;
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
            precomputedAfter:
              precompute?.next ??
              precompute?.through ??
              cursor.precomputedAfter ??
              null,
            speculativeUntil:
              precompute?.waitingUntil ?? cursor.speculativeUntil ?? null,
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
      scopeOf(run, "statement_transaction").importId ?? null,
    ),
    boundary: null,
  }),
  page: async ({ db, run, step, retrying }) => {
    const { labelStatementSuggestions } =
      await import("~/server/domains/transaction-import/service/statement-suggestion-labels");
    let outcome: Awaited<ReturnType<typeof labelStatementSuggestions>>;
    try {
      outcome = await labelStatementSuggestions(db, {
        runId: run.id,
        cooperative: true,
        after: retrying
          ? null
          : z
              .object({
                createdAt: z.string(),
                id: z.string(),
                inclusive: z.boolean().optional(),
              })
              .nullable()
              .parse(step.cursor ?? null),
        importId: scopeOf(run, "statement_transaction").importId ?? null,
      });
    } catch (error) {
      const paused = budgetPause(error);
      if (paused) return paused;
      throw error;
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

/** The Sweep's current (unretried) evaluations of one family. */
async function sweepEvaluations(
  db: Database,
  run: StepRunOwner,
  family: "connection" | "field",
) {
  const items =
    family === "connection"
      ? (await aiEvaluationsForRun(db, run.id)).filter(
          (item) =>
            aiEvaluationTarget.safeParse(item.target).data?.kind ===
            "connection",
        )
      : (await requestedAiEvaluations(db, run.id)).filter(
          (item) => item.executionKind === "suggestion_sweep",
        );
  return items.filter(
    (item) =>
      !z.object({ retryEvaluationId: z.uuid() }).safeParse(item.receipt)
        .success,
  );
}

/**
 * One wait page over the evaluations a roster queued: their states are the
 * step's absolute counts, so a re-read never adds them twice.
 */
function evaluationPage(
  context: StepContext,
  items: Awaited<ReturnType<typeof sweepEvaluations>>,
  extra: Pick<Extract<StepPage, { kind: "progress" }>, "tallies" | "reasons">,
): StepPage {
  const { step } = context;
  const pending = items.filter((item) =>
    PENDING_AI_STATES.includes(item.state),
  ).length;
  const failed = items.filter((item) => item.state === "failed");
  const counts = {
    done: items.filter((item) => item.state === "completed").length,
    failed: failed.length,
    skipped: items.length - pending - failed.length,
  };
  const errors: RunStepError[] = failed.map((item) => ({
    at: item.updatedAt.toISOString(),
    message: item.error ?? "AI evaluation failed",
    ref: `evaluation:${item.id}`,
  }));
  return {
    kind: "progress",
    delta: {
      done: counts.done - step.done,
      failed: counts.failed - step.failed,
      skipped: counts.skipped - step.skipped,
    },
    // Errors are the newest-first sample; only a settled step records them.
    ...(!pending && errors.length && { errors }),
    ...extra,
    absolute: true,
    ...(pending && {
      action: `Waiting for ${pending} of ${items.length} evaluations`,
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

// ---- Connections: roster records as owned evaluations, then wait. ----

const ROSTER_PAGE = 25;

const connectionRoster: StepDriversFor<"sweep">["connection_roster"] = {
  count: countedNow((context, boundary) =>
    countConnectionSweepSources(
      context.db,
      scopeOf(context.run, "recommendation").entityKinds,
      new Date(boundary),
    ),
  ),
  page: async (context) => {
    const { db, run, step } = context;
    const activation = await readAiRefreshActivation(db);
    if (!activation?.enabled || !activation.manifest["entity-connections"]) {
      // An unattended pass with AI refresh off has nothing to evaluate; a
      // member's Sweep reports why instead of finishing quietly.
      if (run.trigger === "scheduled")
        return {
          kind: "progress",
          meta: { detail: { skipped: "AI refresh is not active" } },
          done: true,
        };
      throw new Error(
        "Connection discovery requires an active AI refresh generation",
      );
    }
    const boundary = cutoff(context);
    const page = await prepareConnectionSweepPage(db, {
      runId: run.id,
      after: z
        .string()
        .nullable()
        .parse(step.cursor ?? null),
      limit: ROSTER_PAGE,
      entityKinds: scopeOf(run, "recommendation").entityKinds,
      createdBefore: boundary ? new Date(boundary) : null,
    });
    return {
      kind: "progress",
      delta: { done: page.inserted, skipped: page.scanned - page.inserted },
      reasons: { already_evaluated: page.scanned - page.inserted },
      cursor: page.next,
      done: page.next === null,
    };
  },
};

const connectionEvaluate: StepDriversFor<"sweep">["connection_evaluate"] = {
  count: async ({ db, run }) => ({
    total: (await sweepEvaluations(db, run, "connection")).length,
    boundary: null,
  }),
  page: async (context) => {
    await readmitFailures(context, true);
    const items = await sweepEvaluations(context.db, context.run, "connection");
    return evaluationPage(context, items, {
      reasons: {
        blocked: items.filter((item) => item.state === "blocked").length,
        obsolete: items.filter((item) => item.state === "obsolete").length,
        cancelled: items.filter((item) => item.state === "cancelled").length,
      },
    });
  },
};

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
  // Targets come from the Sweep's own input, a closed population.
  count: async ({ run }) => ({
    total: fieldTargets(scopeOf(run, "field").targets).length,
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
    total: (await sweepEvaluations(db, run, "field")).length,
    boundary: null,
  }),
  page: async (context) => {
    await readmitFailures(context, false);
    const items = await sweepEvaluations(context.db, context.run, "field");
    const receipts = items.flatMap((item) => {
      const receipt = z
        .object({
          outcome: z.string(),
          diagnostics: suggestionSweepRunProgress.shape.diagnostics.optional(),
        })
        .safeParse(item.receipt);
      return receipt.success ? [receipt.data] : [];
    });
    const reasons: Record<string, number> = {};
    for (const diagnostic of receipts.flatMap(
      (receipt) => receipt.diagnostics ?? [],
    ))
      reasons[diagnostic.reason] = (reasons[diagnostic.reason] ?? 0) + 1;
    return evaluationPage(context, items, {
      tallies: {
        applied: receipts.filter((receipt) => receipt.outcome === "applied")
          .length,
        queued: receipts.filter((receipt) => receipt.outcome === "queued")
          .length,
      },
      reasons,
    });
  },
};

export const sweepStepDrivers = {
  transfer_pair_scan: transferPairScan,
  transfer_pair_retire: transferPairRetire,
  transfer_pair_label: transferPairLabel,
  statement_generate: statementGenerate,
  statement_holds: statementHolds,
  statement_label: statementLabel,
  connection_roster: connectionRoster,
  connection_evaluate: connectionEvaluate,
  field_roster: fieldRoster,
  field_evaluate: fieldEvaluate,
} satisfies StepDriversFor<"sweep">;
