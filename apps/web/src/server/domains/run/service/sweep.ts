import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  suggestionSweepRunProgress,
  sweepFamilyScope,
  sweepRunInput,
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import type { RunStepCounts, RunStepError } from "@cubby/schemas/run-step";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import type { Database } from "~/server/db";
import {
  countSuggestionsNeedingLabels,
  countUnmatchedCharges,
  generateStatementSuggestionPage,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { buildCrudServices } from "~/server/http/request-context";
import {
  type WorkflowLauncher,
  productionWorkflowLauncher,
} from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  countConnectionSweepSources,
  ensureConnectionSweepRun,
  prepareConnectionSweepPage,
} from "../repo/connection-refresh";
import { ensureRun, systemActor } from "../repo/ensure-run";
import {
  activeSweepFor,
  readChildRun,
  settleEmptyChildRun,
  type StepRunOwner,
} from "../repo/run-step";
import type { StepDriver, StepPage, StepRunDrivers } from "./step-run";

const FAMILY_LABEL = {
  statement_transaction: "Statements",
  recommendation: "Connections",
  field: "Fields",
} as const satisfies Record<SweepFamilyScope["family"], string>;

/**
 * Starts a Sweep: one step per Suggestion family in scope, run by the
 * StepRunWorkflow. A scheduled Sweep that found nothing ends routine.
 */
export async function startSweep(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  input: {
    trigger: "manual" | "scheduled";
    families: readonly SweepFamilyScope[];
  },
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  const runId = await ensureRun(db, actor, {
    purpose: "sweep",
    trigger: input.trigger,
    status: "running",
    input: sweepRunInput.parse({ kind: "sweep", families: input.families }),
  });
  await launchWorkflowRun(db, { runId, purpose: "sweep" }, launcher);
  return runId;
}

/**
 * The automatic pass over one whole family: a routine Sweep, unless one
 * covering that family is already unfinished.
 */
export async function startRoutineSweep(
  db: Database,
  family: SweepFamilyScope["family"],
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  if (await activeSweepFor(db, family)) return null;
  return startSweep(
    db,
    systemActor(),
    {
      trigger: "scheduled",
      families: [sweepFamilyScope.parse({ family, scope: {} })],
    },
    launcher,
  );
}

/** What a Sweep would look at, from stored state; nothing runs. */
export async function estimateSweep(
  db: Database,
  families: readonly SweepFamilyScope[],
) {
  return Promise.all(
    families.map(async (entry) => {
      switch (entry.family) {
        case "statement_transaction": {
          const charges = await countUnmatchedCharges(db, entry.scope);
          return {
            family: entry.family,
            records: charges,
            // Every charge is matched by rule; labels ask the decision model.
            decisions: await countSuggestionsNeedingLabels(db),
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
  sweepRunInput.parse(owner.input).families.map((entry): StepDriver => {
    const definition = {
      key: entry.family,
      label: FAMILY_LABEL[entry.family],
    };
    switch (entry.family) {
      case "statement_transaction":
        return {
          ...definition,
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

// ---- Statements: rule generation over unmatched charges, then labels. ----

const statementCursor = z.union([
  z.object({
    phase: z.literal("generate"),
    after: z.object({ source: z.string(), chargeKey: z.string() }).nullable(),
  }),
  z.object({
    phase: z.literal("label"),
    after: z.object({ createdAt: z.string(), id: z.string() }).nullable(),
  }),
  z.object({ phase: z.literal("finished") }),
]);

async function statementPage(
  { db, run, step }: PageContext,
  scope: Extract<
    SweepFamilyScope,
    { family: "statement_transaction" }
  >["scope"],
): Promise<StepPage> {
  const parsed = statementCursor.safeParse(step.cursor);
  // A retried step re-runs its labels; generation already covered its charges.
  const cursor = !parsed.success
    ? ({ phase: "generate", after: null } as const)
    : parsed.data.phase === "finished"
      ? ({ phase: "label", after: null } as const)
      : parsed.data;
  if (cursor.phase === "generate") {
    const found =
      cursor.after === null && !parsed.success
        ? await countUnmatchedCharges(db, scope)
        : undefined;
    const page = await generateStatementSuggestionPage(db, {
      after: cursor.after,
      runId: run.id,
      scope,
    });
    return {
      kind: "progress",
      ...(found !== undefined && { found }),
      delta: {
        done: page.published + page.unchanged,
        skipped: page.outOfScope,
      },
      cursor: page.next
        ? { phase: "generate", after: page.next }
        : { phase: "label", after: null },
      done: false,
    };
  }
  const { labelStatementSuggestions } =
    await import("~/server/domains/statement-import/service/statement-suggestion-labels");
  const labelsAhead =
    cursor.after === null ? await countSuggestionsNeedingLabels(db) : 0;
  let outcome: Awaited<ReturnType<typeof labelStatementSuggestions>>;
  try {
    outcome = await labelStatementSuggestions(db, {
      runId: run.id,
      after: cursor.after,
    });
  } catch (error) {
    if (error instanceof AiBudgetExhaustedError)
      return {
        kind: "paused",
        reason: error.message,
        until: new Date(error.status.windowEnd),
      };
    throw error;
  }
  return {
    kind: "progress",
    ...(cursor.after === null &&
      outcome.active && { found: step.found + labelsAhead }),
    delta: {
      done: outcome.labelled,
      skipped: outcome.stale,
      failed: outcome.failed.length,
    },
    errors: outcome.failed,
    ...(!outcome.active && {
      meta: { detail: { labels: "off: automatic AI work is disabled" } },
    }),
    cursor: outcome.next
      ? { phase: "label", after: outcome.next }
      : { phase: "finished" },
    done: outcome.next === null,
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

const ROSTER_PAGE = 200;

async function connectionPage(
  { db, run, step, launcher }: PageContext,
  scope: Extract<SweepFamilyScope, { family: "recommendation" }>["scope"],
): Promise<StepPage> {
  const cursor = connectionCursor.safeParse(step.cursor).success
    ? connectionCursor.parse(step.cursor)
    : { phase: "roster" as const, after: null, childRunId: null };
  const totals = connectionTotals.parse(step.meta?.detail ?? {});
  const childRunId =
    (cursor.childRunId ? runEntityId.parse(cursor.childRunId) : null) ??
    (await ensureConnectionSweepRun(db, actorOf(run), run.id));
  if (!childRunId)
    throw new Error(
      "Connection discovery requires an active AI refresh generation",
    );
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
    if (next.scanned === next.covered) {
      await settleEmptyChildRun(db, childRunId);
      return {
        kind: "child",
        childRunId,
        counts: {
          found: next.scanned,
          done: 0,
          failed: 0,
          skipped: next.covered,
        },
        state: "done",
        meta: { detail: next },
      };
    }
    await launchWorkflowRun(
      db,
      { runId: childRunId, purpose: "ai_refresh" },
      launcher,
    );
    return {
      kind: "child",
      childRunId,
      counts: {
        found: next.scanned,
        done: 0,
        failed: 0,
        skipped: next.covered,
      },
      state: "running",
      cursor: { phase: "run", after: null, childRunId },
      meta: { detail: next },
    };
  }
  const child = await readChildRun(db, childRunId);
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

// ---- Fields: one suggestion_sweep child per entity, in turn. ----

const fieldCursor = z.object({
  index: z.number().int().nonnegative(),
  childRunId: z.uuid().nullable(),
});
const fieldTotals = z
  .object({
    found: z.number().default(0),
    done: z.number().default(0),
    failed: z.number().default(0),
    skipped: z.number().default(0),
  })
  .default({ found: 0, done: 0, failed: 0, skipped: 0 });

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
  { db, run, step, launcher }: PageContext,
  scope: Extract<SweepFamilyScope, { family: "field" }>["scope"],
): Promise<StepPage> {
  const targets = fieldTargets(scope.targets);
  const cursor = fieldCursor.safeParse(step.cursor).success
    ? fieldCursor.parse(step.cursor)
    : { index: 0, childRunId: null };
  const finished = fieldTotals.parse(step.meta?.detail ?? {});
  if (cursor.childRunId) {
    const childRunId = runEntityId.parse(cursor.childRunId);
    const child = await readChildRun(db, childRunId);
    const counts = sweepCounts(child?.progress);
    const ended = child?.status === "completed" || child?.status === "failed";
    if (!ended) return childPage(childRunId, child, add(finished, counts));
    const total = add(finished, counts);
    const nextIndex = cursor.index + 1;
    if (nextIndex >= targets.length)
      return {
        kind: "child",
        childRunId,
        counts: total,
        state: total.failed > 0 ? "failed" : "done",
        meta: { detail: total },
      };
    return startFieldChild(db, run, launcher, targets, nextIndex, total);
  }
  return startFieldChild(db, run, launcher, targets, cursor.index, finished);
}

async function startFieldChild(
  db: Database,
  run: StepRunOwner,
  launcher: WorkflowLauncher,
  targets: ReturnType<typeof fieldTargets>,
  index: number,
  finished: RunStepCounts,
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
      launcher,
      context: {
        ...buildCrudServices(db),
        actorContext: buildActorContext(run.actorUserId, run.channel),
      },
    },
  );
  return {
    kind: "child",
    childRunId: runEntityId.parse(id),
    counts: finished,
    state: "running",
    cursor: { index, childRunId: id },
    meta: { detail: finished },
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
