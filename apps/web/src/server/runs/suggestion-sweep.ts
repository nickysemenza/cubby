import {
  fieldSuggestionsInput,
  type FieldSuggestionsInput,
} from "@cubby/schemas/ai";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  suggestionSweepRunInput,
  suggestionSweepRunProgress,
} from "@cubby/schemas/run-fields";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import type { Database } from "~/server/db";
import {
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { getDb } from "~/server/repo/database-helpers";
import { spendingClassificationRevision } from "~/server/repo/expense-category-resolution";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { applySuggestionValue } from "~/server/repo/suggestion-review";

import { ensureRun } from "./ensure-run";
import { runPacedBatch, type PacedBatchPorts } from "./paced-batch";

type SweepEntity = FieldSuggestionsInput["entity"];
type SweepInput = {
  entity: SweepEntity;
  fields: string[];
  filters: Record<string, SuggestionValue>;
};
export type SuggestionSweepPorts = {
  /** Entity operations need the authenticated request's kernel services. */
  context: EntityKernelContext;
  decisionModel?: () => SupportedDecisionModel;
  pairSample?: (recordId: string) => boolean;
  suggest?: typeof suggestFields;
  suggestPorts?: SuggestFieldsPorts;
  pacePerMinute?: number;
  wait?: (milliseconds: number) => Promise<void>;
  /** Test seam that pauses after a persisted number of processed targets. */
  pauseAfter?: number;
};
type SweepTarget = {
  id: string;
  currentValue: SuggestionValue;
  entityId: string;
  basis: Record<string, string | null>;
  field: string;
};
const suggestionValueSchema: z.ZodType<SuggestionValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(suggestionValueSchema),
    z.record(z.string(), suggestionValueSchema),
  ]),
);
const processedTargetIdsSchema = z
  .object({
    processedTargetIds: z.array(z.string()).default([]),
  })
  .passthrough();
const sweepListRowSchema = z.object({ id: z.string() }).passthrough();
const jsonValue = (value: unknown): SuggestionValue =>
  suggestionValueSchema.parse(value);
const sweepRunInputSchema = suggestionSweepRunInput.transform((input) => ({
  ...input,
  entity: fieldSuggestionsInput.shape.entity.parse(input.entity),
}));
const alternateModel = (
  model: SupportedDecisionModel,
): SupportedDecisionModel =>
  model === "typesafe/jev" ? "@cf/cloudflare/clef" : "typesafe/jev";

async function suggestTarget(
  db: Database,
  runId: RunId,
  input: z.output<typeof sweepRunInputSchema> & { field: string },
  target: SweepTarget,
  pairKey: string | null,
  ports: SuggestionSweepPorts,
) {
  const recommend = ports.suggest ?? suggestFields;
  const fieldInput: FieldSuggestionsInput = {
    entity: input.entity,
    entityId: target.id,
    basisMode: "suggested",
    targets: [input.field],
    basis: target.basis,
  };
  const decisions = await recommend(db, runId, fieldInput, {
    ...ports.suggestPorts,
    decisionModel: input.decisionModel,
  });
  const decision = decisions.suggestions[input.field];
  if (!decision) {
    const entries: SweepSuggestion[] = [];
    return { primary: null, entries, financeReviewFingerprint: null };
  }
  const primary = makeSweepSuggestion({
    currentValue: target.currentValue,
    decision: {
      value: jsonValue(decision.value),
      confidence: decision.probability ?? 0,
      runnerUpValue:
        decision.alternatives[0]?.value == null
          ? undefined
          : jsonValue(decision.alternatives[0].value),
      runnerUpConfidence: decision.alternatives[0]?.probability,
    },
    model: input.decisionModel,
    pinnedModel: input.decisionModel,
    pairKey,
  });
  const entries = primary ? [primary] : [];
  const diagnostics: {
    targetId: string;
    stage: "paired_model";
    reason: string;
  }[] = [];
  if (pairKey) {
    const pairedModel = alternateModel(input.decisionModel);
    try {
      const paired = await recommend(db, runId, fieldInput, {
        ...ports.suggestPorts,
        decisionModel: pairedModel,
      });
      const alt = paired.suggestions[input.field];
      const pairedRow =
        alt &&
        makeSweepSuggestion({
          currentValue: target.currentValue,
          decision: {
            value: jsonValue(alt.value),
            confidence: alt.probability ?? 0,
          },
          model: pairedModel,
          pinnedModel: input.decisionModel,
          pairKey,
        });
      if (pairedRow) entries.push(pairedRow);
    } catch (error) {
      diagnostics.push({
        targetId: target.id,
        stage: "paired_model",
        reason: scrubErrorMessage(String(error)),
      });
    }
  }
  return {
    primary,
    entries,
    financeReviewFingerprint: decision.financeReview?.fingerprint ?? null,
    diagnostics,
  };
}

async function insertSuggestions(
  db: Database,
  runId: RunId,
  entity: SweepEntity,
  field: string,
  recordId: string,
  entries: readonly SweepSuggestion[],
  financeReviewFingerprint: string | null,
) {
  const typedRecordId = parseEntityId(entity, recordId);
  await getDb(db)
    .update(suggestionTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(suggestionTable.entity, entity),
        eq(suggestionTable.recordId, typedRecordId),
        eq(suggestionTable.field, field),
        eq(suggestionTable.status, "pending"),
        ne(suggestionTable.runId, runId),
      ),
    );
  for (const entry of entries) {
    await getDb(db).insert(suggestionTable).values({
      runId,
      entity,
      recordId: typedRecordId,
      field,
      financeReviewFingerprint,
      currentValue: entry.currentValue,
      suggestedValue: entry.suggestedValue,
      confidence: entry.confidence,
      runnerUpValue: entry.runnerUpValue,
      runnerUpConfidence: entry.runnerUpConfidence,
      model: entry.model,
      pairKey: entry.pairKey,
      kind: entry.kind,
      status: "pending",
    });
  }
}

const savedSweep = async (db: Database, runId: RunId) => {
  const [row] = await getDb(db)
    .select()
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!row || row.purpose !== "suggestion_sweep")
    throw new Error("Suggestion sweep Run not found");
  return row;
};

async function executeSweep(
  db: Database,
  runId: RunId,
  ports: SuggestionSweepPorts,
) {
  const saved = await savedSweep(db, runId);
  if (saved.status === "completed")
    throw new Error("Completed suggestion sweep cannot be resumed");
  const input = sweepRunInputSchema.parse(saved.input);
  if (input.paused) return saved.progress;
  let pageIndex = 0;
  let rowsSeen = 0;
  let totalCount = 0;
  const targets: SweepTarget[] = [];
  do {
    const command = entityCommandSchema.parse({
      action: "list",
      entity: input.entity,
      filters: input.filters,
      pagination: { pageIndex, pageSize: 500 },
    });
    const listed = await executeEntity(ports.context, command);
    if (listed.action !== "list")
      throw new Error(
        "Suggestion sweep target read returned a non-list result",
      );
    const items = z.array(sweepListRowSchema).parse(listed.items);
    rowsSeen += items.length;
    totalCount = listed.meta.totalCount;
    for (const row of items) {
      const recordId = await resolveLiveShortcode(db, row.id, input.entity);
      if (!recordId) continue;
      const basis = Object.fromEntries(
        Object.entries(row).flatMap(([key, value]) => {
          const parsed = z.string().nullable().safeParse(value);
          return parsed.success ? [[key, parsed.data]] : [];
        }),
      );
      for (const field of input.fields) {
        const currentValue = suggestionValueSchema.parse(row[field] ?? null);
        targets.push({
          id: row.id,
          entityId: recordId,
          currentValue,
          basis,
          field,
        });
      }
    }
    pageIndex++;
  } while (rowsSeen < totalCount);
  const processed = new Set(
    processedTargetIdsSchema.parse(saved.progress ?? {}).processedTargetIds,
  );
  const pending = targets.filter(
    ({ entityId, field }) => !processed.has(`${entityId}:${field}`),
  );
  const progress =
    saved.progress === null
      ? null
      : suggestionSweepRunProgress.parse(saved.progress);
  // Total counts processed targets plus currently eligible targets still to process.
  const totalTargets = processed.size + pending.length;
  const diagnostics = progress?.diagnostics ?? [];
  const batchPorts: PacedBatchPorts = {
    isPaused: async () => {
      if (
        ports.pauseAfter !== undefined &&
        (progress?.done ?? 0) + (batchDone - batchStart) >= ports.pauseAfter
      ) {
        await setPaused(db, runId, true);
        return true;
      }
      const current = await savedSweep(db, runId);
      return sweepRunInputSchema.parse(current.input).paused;
    },
    saveProgress: async (p) => {
      const progressSnapshot = {
        total: totalTargets,
        done: (progress?.done ?? 0) + p.done,
        applied: (progress?.applied ?? 0) + p.applied,
        queued: (progress?.queued ?? 0) + p.queued,
        failed: (progress?.failed ?? 0) + p.failed,
        processedTargetIds: [...processed],
        diagnostics,
      };
      await getDb(db)
        .update(runTable)
        .set({
          progress: sql`${JSON.stringify(progressSnapshot)}::jsonb`,
        })
        .where(eq(runTable.id, runId));
    },
    wait:
      ports.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const batchStart = progress?.done ?? 0;
  let batchDone = 0;
  const result = await runPacedBatch({
    targets: pending,
    startAt: 0,
    pacePerMinute: ports.pacePerMinute,
    ports: batchPorts,
    work: async (target) => {
      try {
        const pairKey = (ports.pairSample ?? stablePair)(target.entityId)
          ? crypto.randomUUID()
          : null;
        const {
          primary,
          entries,
          financeReviewFingerprint,
          diagnostics: targetDiagnostics = [],
        } = await suggestTarget(
          db,
          runId,
          { ...input, field: target.field },
          target,
          pairKey,
          ports,
        );
        diagnostics.push(...targetDiagnostics);
        await insertSuggestions(
          db,
          runId,
          input.entity,
          target.field,
          target.entityId,
          entries,
          financeReviewFingerprint,
        );
        let outcome: "applied" | "queued" | "failed" =
          primary?.status === "applied" ? "applied" : "queued";
        if (primary?.status === "applied") {
          try {
            const [savedSuggestion] = await getDb(db)
              .select()
              .from(suggestionTable)
              .where(
                and(
                  eq(suggestionTable.runId, runId),
                  eq(suggestionTable.field, target.field),
                  eq(
                    suggestionTable.recordId,
                    parseEntityId(input.entity, target.entityId),
                  ),
                  eq(suggestionTable.model, primary.model),
                ),
              )
              .limit(1);
            if (!savedSuggestion)
              throw new Error("Auto-apply Suggestion was not persisted");
            await applySuggestionValue(
              db,
              ports.context,
              {
                entity: input.entity,
                recordId: target.entityId,
                field: target.field,
                financeReviewFingerprint:
                  savedSuggestion.financeReviewFingerprint,
              },
              primary.suggestedValue,
            );
            await getDb(db)
              .update(suggestionTable)
              .set({ status: "applied" })
              .where(
                and(
                  eq(suggestionTable.runId, runId),
                  eq(suggestionTable.field, target.field),
                  eq(
                    suggestionTable.recordId,
                    parseEntityId(input.entity, target.entityId),
                  ),
                  eq(suggestionTable.model, primary.model),
                ),
              );
          } catch (error) {
            diagnostics.push({
              targetId: target.id,
              stage: "apply",
              reason: scrubErrorMessage(String(error)),
            });
            const recordId = parseEntityId(input.entity, target.entityId);
            await getDb(db)
              .update(suggestionTable)
              .set({ status: "pending" })
              .where(
                and(
                  eq(suggestionTable.runId, runId),
                  eq(suggestionTable.recordId, recordId),
                  eq(suggestionTable.field, target.field),
                ),
              );
            outcome = "queued";
          }
        }
        processed.add(`${target.entityId}:${target.field}`);
        return outcome;
      } catch {
        // SILENT: failed inference is still checkpointed so resume cannot rebill it.
        return "failed";
      } finally {
        processed.add(`${target.entityId}:${target.field}`);
        batchDone++;
      }
    },
  });
  const latest = await savedSweep(db, runId);
  if (!result.paused)
    await getDb(db)
      .update(runTable)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(runTable.id, runId));
  return latest.progress;
}

function stablePair(id: string) {
  let hash = 2166136261;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) % 10 === 0;
}
async function setPaused(db: Database, runId: RunId, paused: boolean) {
  const row = await savedSweep(db, runId);
  const input = sweepRunInputSchema.parse(row.input);
  await getDb(db)
    .update(runTable)
    .set({ input: { ...input, paused } })
    .where(eq(runTable.id, runId));
}
export async function pauseSuggestionSweep(db: Database, runId: RunId) {
  await setPaused(db, runId, true);
}
export async function resumeSuggestionSweep(
  db: Database,
  runId: RunId,
  ports: SuggestionSweepPorts,
) {
  await setPaused(db, runId, false);
  return executeSweep(db, runId, ports);
}
export async function startSuggestionSweep(
  db: Database,
  input: SweepInput,
  ports: SuggestionSweepPorts,
) {
  const decisionModel = ports.decisionModel?.() ?? selectDecisionModel();
  const taxonomyRevision = await spendingClassificationRevision(db);
  const actor = { ...ports.context.actorContext, runId: null };
  const storedInput = suggestionSweepRunInput.parse({
    kind: "suggestion_sweep",
    ...input,
    decisionModel,
    taxonomyRevision,
    paused: false,
  });
  const initialProgress = suggestionSweepRunProgress.parse({
    total: 0,
    done: 0,
    applied: 0,
    queued: 0,
    failed: 0,
    diagnostics: [],
  });
  const runId = await ensureRun(db, actor, {
    purpose: "suggestion_sweep",
    trigger: "manual",
    status: "running",
    input: storedInput,
    progress: initialProgress,
  });
  await executeSweep(db, runId, ports);
  return { id: runId };
}

export type SuggestionValue =
  | string
  | number
  | boolean
  | null
  | SuggestionValue[]
  | { [key: string]: SuggestionValue };
export type SweepDecision = {
  value: SuggestionValue;
  confidence: number;
  runnerUpValue?: SuggestionValue;
  runnerUpConfidence?: number;
};
export type SweepSuggestion = {
  kind: "addition" | "correction";
  status: "applied" | "pending";
  currentValue: SuggestionValue;
  suggestedValue: SuggestionValue;
  confidence: number;
  runnerUpValue: SuggestionValue | null;
  runnerUpConfidence: number | null;
  model: SupportedDecisionModel;
  pairKey: string | null;
};
const isBlank = (value: SuggestionValue) => value == null || value === "";
const equalValue = (left: SuggestionValue, right: SuggestionValue) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Converts a decision into its durable sweep row; only the pinned model may apply an Addition. */
export function makeSweepSuggestion(args: {
  currentValue: SuggestionValue;
  decision: SweepDecision;
  model: SupportedDecisionModel;
  pinnedModel: SupportedDecisionModel;
  pairKey?: string | null;
}): SweepSuggestion | null {
  if (equalValue(args.currentValue, args.decision.value)) return null;
  const kind = isBlank(args.currentValue) ? "addition" : "correction";
  return {
    kind,
    status:
      kind === "addition" &&
      args.decision.confidence >= 0.85 &&
      args.model === args.pinnedModel
        ? "applied"
        : "pending",
    currentValue: args.currentValue,
    suggestedValue: args.decision.value,
    confidence: args.decision.confidence,
    runnerUpValue: args.decision.runnerUpValue ?? null,
    runnerUpConfidence: args.decision.runnerUpConfidence ?? null,
    model: args.model,
    pairKey: args.pairKey ?? null,
  };
}
