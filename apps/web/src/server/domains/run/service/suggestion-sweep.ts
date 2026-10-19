import {
  fieldSuggestionsInput,
  type FieldSuggestionsInput,
} from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import type { RunTrigger } from "@cubby/schemas/purchase-import";
import {
  suggestionSweepRunInput,
  suggestionSweepRunProgress,
} from "@cubby/schemas/run-fields";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
  fieldPolicyKey,
} from "~/server/ai/policy/refresh-manifest";
import { publishAiEvaluation } from "~/server/ai/repo/ai-evaluation";
import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { spendingClassificationRevision } from "~/server/domains/expense/repo/expense-category-resolution";
import { settleArrivedFindingsForProduct } from "~/server/domains/purchase-import/repo/findings";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import type { AuditSampler } from "~/server/generic/assessment/repo/automatic-rules";
import { fieldReviewIdentity } from "~/server/generic/assessment/repo/field-assessment-review";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/audit-log";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { type WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  storeAiEvaluationResult,
  type AiEvaluationRow,
} from "../repo/ai-work-state";
import { ensureRun } from "../repo/ensure-run";
import { withRunTransaction } from "../repo/run";
import {
  jsonValue,
  pauseRunningSuggestionSweep,
  readSuggestionSweepRun,
  saveSweepSuggestions,
  suggestionValueSchema,
  sweepSuggestionSchema,
  writeSuggestionSweepProgress,
  type SuggestionValue,
  type SweepSuggestion,
} from "../repo/suggestion-sweep-state";

type SweepEntity = FieldSuggestionsInput["entity"];
type SweepInput = {
  entity: SweepEntity;
  fields: string[];
  filters: Record<string, SuggestionValue>;
};
/** Who started the sweep: a member (`manual`) or follow-up work (`scheduled`). */
type SweepTrigger = Extract<RunTrigger, "manual" | "scheduled">;
export type SuggestionSweepPorts = {
  /** Entity operations need the authenticated request's kernel services. */
  context: EntityKernelContext;
  launcher?: WorkflowLauncher;
  decisionModel?: () => SupportedDecisionModel;
  suggest?: typeof suggestFields;
  suggestPorts?: SuggestFieldsPorts;
  pacePerMinute?: number;
  wait?: (milliseconds: number) => Promise<void>;
  /** Test seam that pauses after a persisted number of processed targets. */
  pauseAfter?: number;
  /** Persisted pairing regressions must not depend on randomly generated record IDs. */
  samplePair?: (entityId: string) => boolean;
  /** Likewise the Automatic rule audit sample. */
  auditSample?: AuditSampler;
};
type SweepTarget = {
  id: string;
  currentValue: SuggestionValue;
  entityId: string;
  basis: Record<string, string | null>;
  field: string;
};
const processedTargetIdsSchema = z
  .object({
    processedTargetIds: z.array(z.string()).default([]),
  })
  .passthrough();
const sweepListRowSchema = z.object({ id: z.string() }).passthrough();
const sweepRunInputSchema = suggestionSweepRunInput.transform((input) => ({
  ...input,
  entity: fieldSuggestionsInput.shape.entity.parse(input.entity),
}));
const sweepSnapshot = z.object({
  input: sweepRunInputSchema,
  target: z.object({
    id: z.string(),
    currentValue: suggestionValueSchema,
    entityId: z.uuid(),
    basis: z.record(z.string(), z.string().nullable()),
    field: z.string(),
  }),
  fieldDecisionId: z.uuid().nullable(),
  pairKey: z.string().nullable(),
});
const sweepResult = z.object({
  entries: z.array(sweepSuggestionSchema),
  financeReviewFingerprint: z.string().nullable(),
  diagnostics: z
    .array(
      z.object({
        targetId: z.string(),
        stage: z.enum(["paired_model", "apply"]),
        reason: z.string(),
      }),
    )
    .default([]),
  provenance: aiProvenance,
});
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
  const primaryCall = await withAiInputs(false, () =>
    recommend(db, runId, fieldInput, {
      ...ports.suggestPorts,
      decisionModel: input.decisionModel,
    }),
  );
  const manifest = await producingAiManifest(db);
  const decisions = primaryCall.result;
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
    pairKey,
  });
  if (primary) {
    primary.model = primaryCall.inputs[0]?.model ?? input.decisionModel;
    primary.reviewKey = await fieldReviewIdentity({
      entity: input.entity,
      recordId: target.entityId,
      field: input.field,
      currentValue: target.currentValue,
      proposal: decision,
      model: primary.model,
      inputs: primaryCall.inputs,
      dependencies: dependencyStamps(manifest, [
        ...fieldDependencyKeys(input.entity, input.field),
        ...primaryCall.inputs.map((call) => call.feature),
      ]),
    });
  }
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

export async function prepareSuggestionSweep(
  db: Database,
  runId: RunId,
  ports: SuggestionSweepPorts,
) {
  const saved = await readSuggestionSweepRun(db, runId);
  const input = sweepRunInputSchema.parse(saved.input);
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
        Object.entries(row).map(([key, value]) => [key, basisValueOf(value)]),
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
  const selected = new Set(
    targets.map((target) => `${target.entityId}:${target.field}`),
  );
  for (const key of processed) {
    if (selected.has(key)) continue;
    const [entityId, field] = z
      .tuple([z.uuid(), z.string().min(1)])
      .parse(key.split(":"));
    targets.push({
      id: "legacy-processed",
      entityId,
      field,
      currentValue: null,
      basis: {},
    });
  }
  const manifest = await producingAiManifest(db);
  for (const [sequence, target] of targets.entries()) {
    const fieldDecisionId =
      (await latestFieldWrite(db, input.entity, target.entityId, target.field))
        ?.id ?? null;
    const pairKey = (ports.samplePair ?? stablePair)(target.entityId)
      ? crypto.randomUUID()
      : null;
    const snapshot = sweepSnapshot.parse({
      input,
      target,
      fieldDecisionId,
      pairKey,
    });
    const inputFingerprint = await sha256Hex(
      JSON.stringify({
        entity: input.entity,
        target,
        fieldDecisionId,
        model: input.decisionModel,
        paired: Boolean(pairKey),
        taxonomy: input.taxonomyRevision,
        manifest,
      }),
    );
    const legacy = processed.has(`${target.entityId}:${target.field}`);
    await enqueueAiEvaluation(
      db,
      {
        ...(legacy
          ? {
              workKey: `sweep-legacy:${runId}:${target.entityId}:${target.field}`,
              state: "completed",
              receipt: { outcome: "legacy_processed" },
            }
          : {}),
        runId,
        executionKind: "suggestion_sweep",
        shareKey: legacy
          ? null
          : await sha256Hex(
              JSON.stringify({
                kind: "suggestion_sweep",
                actor: ports.context.actorContext.userId,
                inputFingerprint,
              }),
            ),
        feature: fieldPolicyKey(input.entity, target.field),
        target: {
          kind: "field",
          entity: input.entity,
          recordId: target.entityId,
          field: target.field,
          assessmentIds: [],
        },
        provenance: {
          dependencies: dependencyStamps(
            manifest,
            fieldDependencyKeys(input.entity, target.field),
          ),
          inputFingerprint,
          optionFingerprint:
            manifest[fieldPolicyKey(input.entity, target.field)]
              ?.policyFingerprint ?? "",
          model: input.decisionModel,
        },
        snapshot,
      },
      sequence,
    );
  }
  await writeSuggestionSweepProgress(db, runId, {
    ...suggestionSweepRunProgress.parse(saved.progress),
    ...(processed.size
      ? {
          legacyCounts: suggestionSweepRunProgress
            .pick({ done: true, applied: true, queued: true, failed: true })
            .parse(saved.progress),
        }
      : {}),
    rosterPrepared: true,
    attempt: z
      .object({ attempt: z.number().default(0) })
      .parse(saved.progress ?? {}).attempt,
  });
}

export async function executeSuggestionSweepTarget(
  db: Database,
  item: AiEvaluationRow,
  ports: SuggestionSweepPorts,
) {
  if (!item.attemptToken)
    throw new Error("Suggestion sweep has no attempt token");
  const snapshot = sweepSnapshot.parse(item.snapshot);
  const { input, target, pairKey, fieldDecisionId } = snapshot;
  const current = await executeEntity(
    ports.context,
    entityCommandSchema.parse({
      action: "get",
      entity: input.entity,
      id: target.id,
      missing: "null",
    }),
  );
  if (current.action !== "get" || !current.item)
    throw new Error("Suggestion target no longer exists");
  const record = z.record(z.string(), z.unknown()).parse(current.item);
  if (
    canonicalJson(z.json().parse(record[target.field] ?? null)) !==
      canonicalJson(target.currentValue) ||
    (await latestFieldWrite(db, input.entity, target.entityId, target.field))
      ?.id !== (fieldDecisionId ?? undefined)
  )
    throw new Error("Suggestion member decision changed during inference");
  let saved = sweepResult.safeParse(item.result);
  if (!saved.success) {
    const manifest = await producingAiManifest(db);
    const captured = await withAiInputs(false, () =>
      suggestTarget(
        db,
        item.runId,
        { ...input, field: target.field },
        target,
        pairKey,
        ports,
      ),
    );
    const policy = decisionCatalogRows().find(
      (row) => row.entity === input.entity && row.field === target.field,
    );
    const basis = Object.fromEntries(
      [
        ...new Set([
          ...(policy?.basis.map((row) => row.key) ?? []),
          target.field,
        ]),
      ].map((key) => [
        key,
        key === target.field
          ? target.currentValue == null
            ? null
            : typeof target.currentValue === "string"
              ? target.currentValue
              : JSON.stringify(target.currentValue)
          : (target.basis[key] ?? null),
      ]),
    );
    const provenance = {
      dependencies: dependencyStamps(manifest, [
        ...fieldDependencyKeys(input.entity, target.field),
        ...captured.inputs.map((call) => call.feature),
      ]),
      inputFingerprint: await sha256Hex(
        JSON.stringify({
          basis,
          fieldDecisionId,
          inputs: [
            ...new Set(captured.inputs.map((call) => call.fingerprint)),
          ].sort(),
        }),
      ),
      optionFingerprint:
        manifest[fieldPolicyKey(input.entity, target.field)]
          ?.policyFingerprint ?? "",
      model: captured.inputs[0]?.model ?? input.decisionModel,
    };
    saved = sweepResult.safeParse({ ...captured.result, provenance });
    if (!saved.success) throw saved.error;
    if (
      !(await storeAiEvaluationResult(
        db,
        item,
        JSON.parse(JSON.stringify(saved.data)),
      ))
    )
      throw new Error("Suggestion evaluation attempt is obsolete");
  }
  const result = saved.data;
  await publishAiEvaluation(db, item.id, item.attemptToken, async (tx) => {
    const diagnostics = [...result.diagnostics];
    const outcome = await publishSweepSuggestions(
      tx,
      item.runId,
      {
        entity: input.entity,
        field: target.field,
        recordId: target.entityId,
        currentValue: target.currentValue,
        fieldDecisionId,
        evaluationId: item.id,
        provenance: result.provenance,
        rules: {
          pinnedModel: input.decisionModel,
          auditSample: ports.auditSample,
        },
      },
      result.entries,
      result.financeReviewFingerprint,
      { ...ports.context, db: tx },
      (error) =>
        diagnostics.push({
          targetId: target.id,
          stage: "apply",
          reason: scrubErrorMessage(String(error)),
        }),
    );
    return { outcome, diagnostics };
  });
  // A Product's applied category can make it not stock-tracked (ADR 0013),
  // which settles an import's open arrival prompt; checked fresh, so a
  // queued or unchanged category is a no-op.
  if (input.entity === "product" && target.field === "categoryId")
    await settleArrivedFindingsForProduct(
      db,
      parseEntityId("product", target.entityId),
      ports.context.actorContext,
    );
}

/** Publishes one target's proposals; the field's catalog policy decides set ordering. */
export async function publishSweepSuggestions(
  db: Database,
  runId: RunId,
  input: Omit<Parameters<typeof saveSweepSuggestions>[2], "unordered">,
  ...rest: Parameters<typeof saveSweepSuggestions> extends [
    unknown,
    unknown,
    unknown,
    ...infer Rest,
  ]
    ? Rest
    : never
) {
  const unordered =
    decisionCatalogRows().find(
      (row) => row.entity === input.entity && row.field === input.field,
    )?.mode === "prune";
  return saveSweepSuggestions(db, runId, { ...input, unordered }, ...rest);
}

function stablePair(id: string) {
  let hash = 2166136261;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) % 10 === 0;
}
export async function pauseSuggestionSweep(db: Database, runId: RunId) {
  const saved = await readSuggestionSweepRun(db, runId);
  if (saved.status === "paused") return;
  if (saved.status !== "running")
    throw new Error("Only a running sweep can be paused");
  await pauseRunningSuggestionSweep(db, runId);
}
export async function resumeSuggestionSweep(
  db: Database,
  runId: RunId,
  ports: SuggestionSweepPorts,
) {
  const saved = await readSuggestionSweepRun(db, runId);
  if (saved.status === "completed")
    throw new Error("Completed suggestion sweep cannot be resumed");
  if (saved.status !== "paused")
    throw new Error("Only a paused sweep can be resumed");
  await launchWorkflowRun(
    db,
    { runId, purpose: "suggestion_sweep" },
    ports.launcher,
  );
  return saved.progress;
}
export async function startSuggestionSweep(
  db: Database,
  {
    trigger = "manual",
    parentRunId,
    ...input
  }: SweepInput & { trigger?: SweepTrigger; parentRunId?: RunId },
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
  });
  const initialProgress = suggestionSweepRunProgress.parse({
    total: 0,
    done: 0,
    applied: 0,
    queued: 0,
    failed: 0,
    diagnostics: [],
  });
  const runId = await withRunTransaction(db, async (tx) => {
    const runId = await ensureRun(tx, actor, {
      purpose: "suggestion_sweep",
      trigger,
      status: "running",
      input: storedInput,
      progress: initialProgress,
      ...(parentRunId && { parentRunId }),
    });
    await prepareSuggestionSweep(tx, runId, {
      ...ports,
      context: { ...ports.context, db: tx },
    });
    return runId;
  });
  await launchWorkflowRun(
    db,
    { runId, purpose: "suggestion_sweep" },
    ports.launcher,
  );
  return { id: runId };
}

export type SweepDecision = {
  value: SuggestionValue;
  confidence: number;
  runnerUpValue?: SuggestionValue;
  runnerUpConfidence?: number;
};
const isBlank = (value: SuggestionValue) => value == null || value === "";
const equalValue = (left: SuggestionValue, right: SuggestionValue) =>
  canonicalJson(left) === canonicalJson(right);

/**
 * Converts a decision into its durable sweep row, always pending. Only the
 * `field.addition` Automatic rule may then apply it.
 */
export function makeSweepSuggestion(args: {
  currentValue: SuggestionValue;
  decision: SweepDecision;
  model: SupportedDecisionModel;
  pairKey?: string | null;
}): SweepSuggestion | null {
  if (equalValue(args.currentValue, args.decision.value)) return null;
  return {
    kind: isBlank(args.currentValue) ? "addition" : "correction",
    currentValue: args.currentValue,
    suggestedValue: args.decision.value,
    confidence: args.decision.confidence,
    runnerUpValue: args.decision.runnerUpValue ?? null,
    runnerUpConfidence: args.decision.runnerUpConfidence ?? null,
    model: args.model,
    pairKey: args.pairKey ?? null,
  };
}
