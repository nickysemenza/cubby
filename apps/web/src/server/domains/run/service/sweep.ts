import { buildActorContext, systemActor } from "@cubby/schemas/context";
import { suggestFieldKeys } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import type { RunId } from "@cubby/schemas/identifiers";
import {
  sweepFamilyScope,
  sweepRunInput,
  type RunCause,
  type SweepFamily,
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import { z } from "zod";

import type { Database } from "~/server/db";
import { buildCrudServices } from "~/server/http/request-context";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { ensureRun } from "../repo/ensure-run";
import { activeSweepFor, type StepRunOwner } from "../repo/run-step";
import type { StepDriversFor } from "./run-step-registry";

/**
 * Starts a Sweep: the declared steps of each family in scope, run by the
 * universal task. A scheduled Sweep that found nothing ends routine.
 */
export async function startSweep(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  input: {
    trigger: "manual" | "scheduled";
    families: readonly SweepFamilyScope[];
    /** The Run whose completion started this Sweep, nested under it. */
    parentRunId?: RunId;
    cause?: RunCause;
  },
) {
  // `actor.runId` must stay null: `ensureRun` returns an inherited Run, so the
  // parent travels as `parentRunId` and the Sweep gets a Run of its own.
  const runId = await ensureRun(db, actor, {
    purpose: "sweep",
    trigger: input.trigger,
    status: "running",
    parentRunId: input.parentRunId,
    cause: input.cause,
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
      tallies: { asks: queued },
      cursor: index + 1,
      done: index + 1 >= targets.length,
    };
  },
};

const fieldEvaluate: StepDriversFor<"sweep">["field_evaluate"] = {
  count: async ({ db, run }) => ({
    total: (await (await import("~/server/kernel/api")).runWork(db, run.id))
      .asks.length,
    boundary: null,
  }),
  page: async ({ db, run, step }) => {
    const { asks } = await (
      await import("~/server/kernel/api")
    ).runWork(db, run.id);
    const completed = asks.filter((ask) => ask.state === "answered").length;
    const failed = asks.filter((ask) => ask.stage === "stuck").length;
    const skipped = asks.filter((ask) => ask.state === "abandoned").length;
    const pending = asks.length - completed - failed - skipped;
    if (pending === 0)
      await (
        await import("../repo/ai-work-state")
      ).settleFieldSweepEffects(
        db,
        run.id,
        buildActorContext(run.actorUserId, run.channel, { runId: run.id }),
      );
    return {
      kind: "progress",
      absolute: true,
      delta: {
        done: completed - step.done,
        failed: failed - step.failed,
        skipped: skipped - step.skipped,
      },
      tallies: { answers: completed, pending },
      ...(pending
        ? { action: `Waiting for ${pending} answers`, waitSeconds: 5 }
        : {}),
      done: pending === 0,
    };
  },
};

export const sweepStepDrivers = {
  field_roster: fieldRoster,
  field_evaluate: fieldEvaluate,
} satisfies StepDriversFor<"sweep">;
