import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  SWEEP_FAMILY_LABEL,
  suggestionSweepRunProgress,
  sweepFamilyScope,
  sweepRunInput,
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import type { RunStepCounts, RunStepError } from "@cubby/schemas/run-step";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import type { Database } from "~/server/db";
import {
  countTransferPairsNeedingLabels,
  discoverTransferPairs,
  transferPairNeedsLabels,
  generateTransferPairSuggestionsPage,
  transferPairGenerationCursor,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import {
  countSuggestionsNeedingLabels,
  countUnmatchedCharges,
  generateStatementSuggestionPage,
  generateStatementHoldVoidPage,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { STATEMENT_LABEL_BATCH } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { buildCrudServices } from "~/server/http/request-context";
import { isWorkflowRunPurpose } from "~/server/workflows/runs/contract";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  countConnectionSweepSources,
  ensureConnectionSweepRun,
  prepareConnectionSweepPage,
  ConnectionAdmissionDeferred,
} from "../repo/connection-refresh";
import { ensureRun, systemActor } from "../repo/ensure-run";
import {
  activeSweepFor,
  holdChildRun,
  readChildRun,
  settleEmptyChildRun,
  type StepRunOwner,
} from "../repo/run-step";
import type { StepDriver, StepPage, StepRunDrivers } from "./step-run";

/**
 * Starts a Sweep: one step per Suggestion family in scope, run by the
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

export const sweepDrivers: StepRunDrivers = async (_db, owner) =>
  // Statement clean evidence consumes the transfer family's descriptor labels.
  sweepRunInput
    .parse(owner.input)
    .families.slice()
    .sort(
      (a, b) =>
        Number(b.family === "transfer_pair") -
        Number(a.family === "transfer_pair"),
    )
    .map((entry): StepDriver => {
      const definition = {
        key: entry.family,
        label: SWEEP_FAMILY_LABEL[entry.family],
      };
      switch (entry.family) {
        case "transfer_pair":
          return {
            ...definition,
            page: (context) => transferPairPage(context, entry.scope),
          };
        case "statement_transaction":
          return {
            ...definition,
            describe: (step) => {
              const parsed = statementCursor.safeParse(step.cursor);
              const generating =
                !parsed.success ||
                parsed.data.phase === "generate" ||
                parsed.data.phase === "holds";
              return {
                phase: generating ? "generate" : "label",
                unit: generating ? "charges" : "suggestions",
                limit: generating
                  ? JOB_PAGE_LIMITS.suggestionsPerPage
                  : STATEMENT_LABEL_BATCH,
                processed: generating
                  ? step.done + step.skipped + step.failed
                  : step.meta?.work?.current.phase === "statement_label"
                    ? step.meta.work.current.processed
                    : 0,
              };
            },
            page: (context) => statementPage(context, entry.scope),
          };
        case "recommendation":
          return {
            ...definition,
            page: (context) => connectionPage(context, entry.scope),
          };
        case "field":
          return {
            ...definition,
            page: (context) => fieldPage(context, entry.scope),
          };
      }
    });

type PageContext = Parameters<StepDriver["page"]>[0];

const transferPairCursor = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("generate"),
    after: transferPairGenerationCursor.nullable(),
  }),
  z.object({
    phase: z.literal("label"),
    after: z.object({ createdAt: z.string(), id: z.string() }).nullable(),
  }),
  z.object({ phase: z.literal("finished") }),
]);

async function transferPairPage(
  { db, run, step, retrying }: PageContext,
  scope: Extract<SweepFamilyScope, { family: "transfer_pair" }>["scope"],
): Promise<StepPage> {
  const parsed = transferPairCursor.safeParse(step.cursor);
  if (!parsed.success || parsed.data.phase === "generate") {
    const page = await generateTransferPairSuggestionsPage(db, {
      runId: run.id,
      scope,
      after:
        parsed.success && parsed.data.phase === "generate"
          ? parsed.data.after
          : null,
    });
    return {
      kind: "progress",
      retryable: true,
      retryAccounting: "replace",
      execution: {
        phase: "transfer_pair_generate",
      },
      found: step.found + page.found,
      delta: {
        done: Math.max(0, page.found - page.failed.length),
        failed: page.failed.length,
      },
      errors: page.failed,
      cursor: page.next
        ? { phase: "generate", after: page.next }
        : { phase: "label", after: null },
      done: false,
    };
  }
  if (parsed.data.phase === "finished" && !retrying)
    return { kind: "progress", done: true };
  const after = parsed.data.phase === "finished" ? null : parsed.data.after;
  const labelsAhead =
    after === null
      ? await countTransferPairsNeedingLabels(db, { runId: run.id })
      : 0;
  const { labelTransferPairSuggestions } =
    await import("~/server/domains/financial-transaction/service/transfer-pair-labels");
  let outcome: Awaited<ReturnType<typeof labelTransferPairSuggestions>>;
  try {
    outcome = await labelTransferPairSuggestions(db, {
      runId: run.id,
      after,
      cooperative: true,
    });
  } catch (error) {
    if (error instanceof AiBudgetExhaustedError)
      return {
        kind: "paused",
        reason: error.message,
        until: new Date(error.resumeAt),
        waitReason: "ai_funding_window",
      };
    throw error;
  }
  return {
    kind: "progress",
    retryable: true,
    skippedIds: outcome.skippedIds,
    execution: {
      phase: "transfer_pair_label",
    },
    ...(after === null &&
      outcome.active && {
        found: Math.max(
          step.found,
          step.done + step.skipped + step.failed + labelsAhead,
        ),
      }),
    delta: {
      done: outcome.completed,
      skipped: outcome.stale,
      failed: outcome.failed.length,
    },
    errors: outcome.failed,
    ...(!outcome.active && {
      meta: { detail: { labels: "off: automatic AI work is disabled" } },
    }),
    cursor:
      outcome.next || outcome.waitingUntil !== null
        ? { phase: "label", after: outcome.next }
        : { phase: "finished" },
    done: outcome.next === null && outcome.waitingUntil === null,
    ...(outcome.waitingUntil !== null && {
      waitSeconds: Math.max(
        1,
        Math.ceil((outcome.waitingUntil - Date.now()) / 1_000),
      ),
    }),
  };
}

// ---- Statements: rule generation over unmatched charges, then labels. ----

const statementCursor = z.union([
  z.object({
    phase: z.literal("generate"),
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
  }),
  z.object({ phase: z.literal("holds"), after: z.string().nullable() }),
  z.object({
    phase: z.literal("label"),
    after: z
      .object({
        createdAt: z.string(),
        id: z.string(),
        inclusive: z.boolean().optional(),
      })
      .nullable(),
  }),
  z.object({ phase: z.literal("finished") }),
]);

type StatementScope = Extract<
  SweepFamilyScope,
  { family: "statement_transaction" }
>["scope"];

async function statementGenerationPage(
  { db, run, step }: PageContext,
  scope: StatementScope,
  cursor: Extract<z.infer<typeof statementCursor>, { phase: "generate" }>,
  initial: boolean,
): Promise<StepPage> {
  const found =
    cursor.after === null && initial
      ? await countUnmatchedCharges(db, scope)
      : undefined;
  const generation = generateStatementSuggestionPage(db, {
    limit: JOB_PAGE_LIMITS.suggestionsPerPage,
    after: cursor.after,
    runId: run.id,
    scope,
  });
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
  const previous = step.meta?.work?.current;
  return {
    kind: "progress",
    retryable: true,
    retryAccounting: "replace",
    execution: {
      phase: "statement_generate",
    },
    work: {
      phase: "statement_generate",
      label: "Generating suggestions",
      unit: "charges",
      // Generation is the first phase: ledger counts carry work done before
      // phase sampling was deployed, so a handoff cannot restart at zero.
      processed: step.done + step.skipped + step.failed + page.processed,
      total:
        found ??
        (previous?.phase === "statement_generate" ? previous.total : null) ??
        (step.found > 0 ? step.found : null),
      failures:
        (previous?.phase === "statement_generate" ? previous.failures : 0) +
        page.failed.length,
      finished: page.next === null,
    },
    labels: { reused: page.labelsReused, generated: 0 },
    pageProcessed: page.processed,
    ...(found !== undefined && { found }),
    delta: {
      done: Math.max(0, page.processed - page.outOfScope - page.failed.length),
      skipped: page.outOfScope,
      failed: page.failed.length,
    },
    errors: page.failed,
    cursor: page.next
      ? {
          phase: "generate",
          after: page.next,
          precomputedAfter:
            precompute?.next ??
            precompute?.through ??
            cursor.precomputedAfter ??
            null,
          speculativeUntil:
            precompute?.waitingUntil ?? cursor.speculativeUntil ?? null,
        }
      : { phase: "holds", after: null },
    done: false,
  };
}

async function statementPage(
  context: PageContext,
  scope: Extract<
    SweepFamilyScope,
    { family: "statement_transaction" }
  >["scope"],
): Promise<StepPage> {
  const { db, run, step, retrying } = context;
  const parsed = statementCursor.safeParse(step.cursor);
  // A retried step re-runs its labels; generation already covered its charges.
  const cursor: z.infer<typeof statementCursor> = !parsed.success
    ? ({ phase: "generate", after: null } as const)
    : parsed.data.phase === "finished"
      ? ({ phase: "label", after: null } as const)
      : parsed.data;
  if (cursor.phase === "generate")
    return statementGenerationPage(context, scope, cursor, !parsed.success);
  if (cursor.phase === "holds") {
    const page = await generateStatementHoldVoidPage(db, {
      after: cursor.after,
      runId: run.id,
      scope,
      limit: JOB_PAGE_LIMITS.suggestionsPerPage,
    });
    const previous = step.meta?.work?.current;
    return {
      kind: "progress",
      retryable: true,
      retryAccounting: "replace",
      execution: {
        phase: "statement_holds",
      },
      delta: {
        done: Math.max(0, page.processed - page.failed.length),
        failed: page.failed.length,
      },
      errors: page.failed,
      work: {
        phase: "statement_holds",
        label: "Checking vanished holds",
        unit: "holds",
        processed:
          (previous?.phase === "statement_holds" ? previous.processed : 0) +
          page.processed,
        total: null,
        failures:
          (previous?.phase === "statement_holds" ? previous.failures : 0) +
          page.failed.length,
        finished: page.next === null,
      },
      cursor: page.next
        ? { phase: "holds", after: page.next }
        : { phase: "label", after: null },
      done: false,
    };
  }
  const { labelStatementSuggestions } =
    await import("~/server/domains/transaction-import/service/statement-suggestion-labels");
  const labelsAhead =
    cursor.after === null
      ? await countSuggestionsNeedingLabels(db, scope.importId ?? null)
      : 0;
  let outcome: Awaited<ReturnType<typeof labelStatementSuggestions>>;
  try {
    outcome = await labelStatementSuggestions(db, {
      runId: run.id,
      cooperative: true,
      after: cursor.after,
      importId: scope.importId ?? null,
    });
  } catch (error) {
    if (error instanceof AiBudgetExhaustedError)
      return {
        kind: "paused",
        reason: error.message,
        until: new Date(error.resumeAt),
        waitReason: "ai_funding_window",
      };
    throw error;
  }
  const previous = step.meta?.work?.current;
  const samePhase = previous?.phase === "statement_label";
  const checkpoint = {
    skippedIds: outcome.skippedIds,
    labels: outcome.labels,
    work: {
      phase: "statement_label",
      label: "Labelling suggestions",
      unit: "suggestions",
      processed:
        (samePhase
          ? Math.max(0, previous.processed - (retrying ? previous.failures : 0))
          : 0) +
        outcome.completed +
        outcome.stale +
        outcome.failed.length,
      total: samePhase ? previous.total : outcome.active ? labelsAhead : null,
      failures:
        (samePhase && !retrying ? previous.failures : 0) +
        outcome.failed.length,
      finished: outcome.next === null && !outcome.paused,
    },
    delta: {
      done: outcome.completed,
      skipped: outcome.stale,
      failed: outcome.failed.length,
    },
    errors: outcome.failed,
    cursor: outcome.next
      ? { phase: "label", after: outcome.next }
      : { phase: "finished" },
  };
  if (outcome.paused)
    return {
      ...checkpoint,
      kind: "paused",
      reason: outcome.paused.reason,
      until: new Date(outcome.paused.until),
      waitReason: "ai_funding_window",
      delta: {
        ...checkpoint.delta,
        ...(cursor.after === null && { found: labelsAhead }),
      },
    };
  return {
    ...checkpoint,
    kind: "progress",
    retryable: true,
    done: outcome.next === null,
    execution: {
      phase: "statement_label",
    },
    ...(outcome.waitingUntil !== null && {
      waitSeconds: Math.max(
        1,
        Math.ceil((outcome.waitingUntil - Date.now()) / 1_000),
      ),
    }),
    ...(cursor.after === null &&
      outcome.active && { found: step.found + labelsAhead }),
    ...(!outcome.active && {
      meta: { detail: { labels: "off: automatic AI work is disabled" } },
    }),
  };
}

// ---- Connections: a roster of sources on one child ai_refresh Run. ----

const connectionCursor = z.object({
  phase: z.enum(["roster", "run"]),
  after: z.string().nullable(),
  childRunId: z.uuid().nullable(),
});
const connectionTotals = z
  .object({ scanned: z.number().default(0), covered: z.number().default(0) })
  .default({ scanned: 0, covered: 0 });

const ROSTER_PAGE = 10;

async function connectionPage(
  { db, run, step, retrying }: PageContext,
  scope: Extract<SweepFamilyScope, { family: "recommendation" }>["scope"],
): Promise<StepPage> {
  const cursor = connectionCursor.safeParse(step.cursor).success
    ? connectionCursor.parse(step.cursor)
    : { phase: "roster" as const, after: null, childRunId: null };
  const totals = connectionTotals.parse(step.meta?.detail ?? {});
  let childRunId = cursor.childRunId
    ? runEntityId.parse(cursor.childRunId)
    : null;
  if (!childRunId) {
    try {
      childRunId = await ensureConnectionSweepRun(
        db,
        actorOf(run),
        run.id,
        run.trigger === "scheduled" ? "scheduled" : "manual",
      );
    } catch (error) {
      if (error instanceof ConnectionAdmissionDeferred)
        return {
          kind: "paused",
          reason: error.message,
          until: new Date(Date.now() + 60_000),
        };
      throw error;
    }
    if (!childRunId) {
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
    await holdChildRun(db, childRunId);
  }
  if (cursor.phase === "roster") {
    const page = await prepareConnectionSweepPage(db, {
      childRunId,
      after: cursor.after,
      limit: ROSTER_PAGE,
      entityKinds: scope.entityKinds,
    });
    const next = {
      scanned: totals.scanned + page.scanned,
      covered: totals.covered + (page.scanned - page.inserted),
    };
    if (page.next)
      return {
        kind: "progress",
        delta: { found: page.scanned, skipped: page.scanned - page.inserted },
        cursor: { phase: "roster", after: page.next, childRunId },
        meta: { detail: next },
        done: false,
      };
    const counts = {
      found: next.scanned,
      done: 0,
      failed: 0,
      skipped: next.covered,
    };
    if (next.scanned === next.covered) {
      await settleEmptyChildRun(db, childRunId);
      return {
        kind: "child",
        childRunId,
        counts,
        state: "done",
        meta: { detail: next },
      };
    }
    // The child was held paused while its roster grew; nothing else starts it.
    const launched = await launchWorkflowRun(db, {
      runId: childRunId,
      purpose: "ai_refresh",
      automatic: true,
    });
    if (!launched)
      return childPage(childRunId, await readChildRun(db, childRunId), counts);
    return {
      kind: "child",
      childRunId,
      counts,
      state: "running",
      cursor: { phase: "run", after: null, childRunId },
      meta: { detail: next },
    };
  }
  let child = await readChildRun(db, childRunId);
  if (retrying && child?.status === "failed") {
    await retryChild(db, run, child);
    child = await readChildRun(db, childRunId);
  }
  const progress = aiRefreshProgress.safeParse(child?.progress ?? {});
  const counts = progress.success ? progress.data : aiRefreshProgress.parse({});
  return childPage(
    childRunId,
    child,
    {
      found: totals.scanned,
      done: counts.completed,
      failed: counts.failed,
      skipped:
        totals.covered +
        counts.blocked +
        (counts.obsolete ?? 0) +
        (counts.cancelled ?? 0),
    },
    (counts.errors ?? []).map((message) => ({ message })),
  );
}

/** "Retry failed" on a child-backed step re-admits the child's own failures. */
async function retryChild(
  db: Database,
  run: StepRunOwner,
  child: NonNullable<Awaited<ReturnType<typeof readChildRun>>>,
) {
  if (!isWorkflowRunPurpose(child.purpose)) return;
  const { controlWorkflowRun } =
    await import("~/server/workflows/runs/control");
  await controlWorkflowRun(
    db,
    actorOf(run),
    { runPublicId: child.shortcode, action: "retry" },
    child.purpose,
  );
}

// ---- Fields: one suggestion_sweep child per entity, in turn. ----

const fieldCursor = z.object({
  /** The target whose child is the latest one. */
  index: z.number().int().nonnegative(),
  /** Every child started so far, one per target, in order. */
  childRunIds: z.array(z.uuid()),
});

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

async function fieldPage(
  { db, run, step, retrying }: PageContext,
  scope: Extract<SweepFamilyScope, { family: "field" }>["scope"],
): Promise<StepPage> {
  const targets = fieldTargets(scope.targets);
  const cursor = fieldCursor.safeParse(step.cursor).success
    ? fieldCursor.parse(step.cursor)
    : { index: 0, childRunIds: [] };
  if (!cursor.childRunIds.length)
    return startFieldChild(db, run, targets, 0, []);
  const read = () =>
    Promise.all(
      cursor.childRunIds.map((id) => readChildRun(db, runEntityId.parse(id))),
    );
  let children = await read();
  if (retrying) {
    for (const child of children)
      if (child?.status === "failed") await retryChild(db, run, child);
    children = await read();
  }
  // Totals are re-summed over every child on each page, so a retried child's
  // counts replace its old ones instead of adding to them.
  const failedChildren = cursor.childRunIds.flatMap((id, index) => {
    const child = children[index];
    return !child ||
      child.status === "failed" ||
      child.status === "dispatch_failed"
      ? [{ id, child }]
      : [];
  });
  const summed = children.reduce(
    (total, child) => add(total, sweepCounts(child?.progress)),
    { found: 0, done: 0, failed: 0, skipped: 0 },
  );
  // A child that crashed before recording a failed evaluation still failed.
  const counts = {
    ...summed,
    failed: Math.max(summed.failed, failedChildren.length),
  };
  const latestId = runEntityId.parse(cursor.childRunIds.at(-1));
  const latest = children.at(-1) ?? null;
  const unfinished = children.some(
    (child) =>
      child &&
      !["completed", "failed", "dispatch_failed"].includes(child.status),
  );
  if (unfinished)
    return latest?.status === "paused_auth"
      ? childPage(latestId, latest, counts)
      : { kind: "child", childRunId: latestId, counts, state: "running" };
  if (cursor.index + 1 < targets.length)
    return startFieldChild(
      db,
      run,
      targets,
      cursor.index + 1,
      cursor.childRunIds,
      counts,
    );
  const errors = failedChildren.map(({ id, child }) => ({
    at: new Date().toISOString(),
    message:
      child?.dispatchError ??
      child?.failureCode ??
      "The field Sweep Run was deleted",
    ref: `run:${child?.shortcode ?? id}`,
  }));
  return {
    kind: "child",
    childRunId: latestId,
    counts,
    state: counts.failed > 0 ? "failed" : "done",
    ...(errors.length && { errors }),
  };
}

async function startFieldChild(
  db: Database,
  run: StepRunOwner,
  targets: ReturnType<typeof fieldTargets>,
  index: number,
  started: readonly string[],
  counts: RunStepCounts = { found: 0, done: 0, failed: 0, skipped: 0 },
): Promise<StepPage> {
  const target = targets[index];
  if (!target)
    throw new Error(`The field Sweep has no target at position ${index}`);
  const { startSuggestionSweep } = await import("./suggestion-sweep");
  const { id } = await startSuggestionSweep(
    db,
    {
      entity: z.enum(shortcodeEntities).parse(target.entity),
      fields: target.fields,
      filters: target.filters,
      trigger: run.trigger === "scheduled" ? "scheduled" : "manual",
      parentRunId: run.id,
    },
    {
      context: {
        ...buildCrudServices(db),
        actorContext: buildActorContext(run.actorUserId, run.channel),
      },
    },
  );
  return {
    kind: "child",
    childRunId: runEntityId.parse(id),
    counts,
    state: "running",
    cursor: { index, childRunIds: [...started, id] },
    again: true,
  };
}

const sweepCounts = (progress: unknown): RunStepCounts => {
  const parsed = suggestionSweepRunProgress.safeParse(progress);
  if (!parsed.success) return { found: 0, done: 0, failed: 0, skipped: 0 };
  return {
    found: parsed.data.total,
    done: parsed.data.done,
    failed: parsed.data.failed,
    skipped: 0,
  };
};

const add = (left: RunStepCounts, right: RunStepCounts): RunStepCounts => ({
  found: left.found + right.found,
  done: left.done + right.done,
  failed: left.failed + right.failed,
  skipped: left.skipped + right.skipped,
});

/** How a parent step reads a child: its totals and whether it has ended. */
function childPage(
  childRunId: RunId,
  child: Awaited<ReturnType<typeof readChildRun>>,
  counts: RunStepCounts,
  errors: Pick<RunStepError, "message">[] = [],
): StepPage {
  const stamped = errors.map((error) => ({
    at: new Date().toISOString(),
    message: error.message,
  }));
  if (!child)
    return {
      kind: "child",
      childRunId,
      counts,
      state: "failed",
      errors: [
        { at: new Date().toISOString(), message: "The child Run was deleted" },
      ],
    };
  if (child.status === "paused_auth")
    return {
      kind: "child",
      childRunId,
      counts,
      state: "paused",
      reason: child.dispatchError ?? "The child Run is paused",
      pausedUntil: null,
    };
  if (child.status === "failed" || child.status === "dispatch_failed")
    return {
      kind: "child",
      childRunId,
      counts,
      state: "failed",
      errors: [
        ...stamped,
        {
          at: new Date().toISOString(),
          message:
            child.dispatchError ?? child.failureCode ?? "The child Run failed",
        },
      ],
    };
  return {
    kind: "child",
    childRunId,
    counts,
    state: child.status === "completed" ? "done" : "running",
    ...(stamped.length && { errors: stamped }),
  };
}

/** The member a child Run acts for; never the parent's Run, which would be inherited. */
const actorOf = (run: StepRunOwner) =>
  buildActorContext(run.actorUserId, run.channel);
