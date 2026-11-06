import {
  fieldSuggestionsInput,
  type FieldSuggestionsInput,
} from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  basisValueOf,
  fieldSuggestionContextKeys,
  fieldSuggestionResolutionContext,
} from "@cubby/schemas/field-suggestion";
import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import { sweepFieldTargets } from "@cubby/schemas/run-fields";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import {
  AiEvaluationAttemptObsoleteError,
  publishAiEvaluation,
  storeAiEvaluationResult,
  type ClaimedAiEvaluation,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import { enqueueAiEvaluation } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
  fieldPolicyKey,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { spendingClassificationRevision } from "~/server/domains/expense/repo/expense-category-resolution";
import { settleArrivedFindingsForProduct } from "~/server/domains/purchase-import/repo/findings";
import { aiRunOwner } from "~/server/domains/run/repo/ai-call-owner";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { readSelectedEntityRecords } from "~/server/entity-kernel/selected-read";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { JobTargetError } from "~/server/generic/jobs/errors";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import { fieldReviewIdentity } from "~/server/generic/suggestions/repo/field-suggestion-review";
import { canonicalJson } from "~/server/lib/canonical-json";

import {
  jsonValue,
  saveSweepSuggestions,
  suggestionValueSchema,
  sweepSuggestionSchema,
  type SuggestionValue,
  type SweepSuggestion,
} from "../repo/suggestion-sweep-state";

export type SuggestionSweepPorts = {
  /** Entity operations need the authenticated request's kernel services. */
  context: EntityKernelContext;
  decisionModel?: () => SupportedDecisionModel;
  suggest?: typeof suggestFields;
  suggestPorts?: SuggestFieldsPorts;
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
const sweepListRowSchema = z.object({ id: z.string() }).passthrough();
const sweepRunInputSchema = sweepFieldTargets.element.extend({
  entity: fieldSuggestionsInput.shape.entity,
  model: supportedDecisionModelSchema.optional(),
  taxonomyRevision: z.string().optional(),
});
type SweepInput = z.infer<typeof sweepRunInputSchema>;
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
});
const sweepResult = z.object({
  entries: z.array(sweepSuggestionSchema),
  financeReviewFingerprint: z.string().nullable(),
  diagnostics: z
    .array(
      z.object({
        targetId: z.string(),
        // Results saved before paired trials were removed may carry `paired_model`.
        stage: z.enum(["paired_model", "apply"]),
        reason: z.string(),
      }),
    )
    .default([]),
  provenance: aiProvenance,
});
async function suggestTarget(
  db: Database,
  runId: RunId | null,
  input: z.output<typeof sweepRunInputSchema> & { field: string },
  target: SweepTarget,
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
    recommend(db, aiRunOwner(runId), fieldInput, {
      ...ports.suggestPorts,
      decisionModel: input.model,
    }),
  );
  const manifest = await producingAiManifest(db);
  const decisions = primaryCall.result;
  const decision = decisions.suggestions[input.field];
  if (!decision) {
    const entries: SweepSuggestion[] = [];
    return {
      primary: null,
      entries,
      financeReviewFingerprint: null,
    };
  }
  const model =
    [...primaryCall.inputs]
      .reverse()
      .find(
        (call) =>
          call.operation === `suggestFields.${input.entity}.${input.field}`,
      )?.model ??
    input.model ??
    "unknown";
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
    model,
  });
  if (primary) {
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
  return {
    primary,
    entries: primary ? [primary] : [],
    financeReviewFingerprint: decision.financeReview?.fingerprint ?? null,
  };
}

/** The stored input a field pass evaluates under, captured by its roster step. */
export async function suggestionSweepInput(
  db: Database,
  input: SweepInput,
  ports: Pick<SuggestionSweepPorts, "decisionModel" | "suggestPorts"> = {},
) {
  return sweepRunInputSchema.parse({
    ...input,
    model: ports.decisionModel?.() ?? ports.suggestPorts?.decisionModel,
    taxonomyRevision: await spendingClassificationRevision(db),
  });
}

/**
 * Queues one AI evaluation per listed record and decision field, requested
 * by the owning Sweep field step.
 * Returns how many evaluations it requested.
 */
export async function rosterSuggestionTargets(
  db: Database,
  runId: RunId,
  storedInput: unknown,
  ports: SuggestionSweepPorts,
) {
  const input = sweepRunInputSchema.parse(storedInput);
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
    totalCount = z.number().parse(listed.meta.totalCount);
    const recordIds = await resolveLiveShortcodes(
      db,
      items.map((row) => row.id),
      input.entity,
    );
    for (const row of items) {
      const recordId = recordIds.get(row.id);
      if (!recordId) continue;
      const governedFields = entityFieldEnvelopeFields[input.entity];
      const valueOf = (key: string) => {
        if (!Object.hasOwn(governedFields, key)) return row[key];
        const envelope = fieldEnvelopeFor(row, key);
        return envelope ? fieldValueOf(envelope) : null;
      };
      const basis = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(row).filter((key) => key !== "fields"),
            ...Object.keys(governedFields),
          ]),
        ].map((key) => [key, basisValueOf(valueOf(key))]),
      );
      for (const field of input.fields) {
        const envelope = fieldEnvelopeFor(row, field);
        if (
          Object.hasOwn(governedFields, field) &&
          (!envelope || envelope.result.kind === "missing")
        )
          continue;
        const currentValue = suggestionValueSchema.parse(
          valueOf(field) ?? null,
        );
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
  const manifest = await producingAiManifest(db);
  for (const [sequence, target] of targets.entries()) {
    const fieldDecisionId =
      (await latestFieldWrite(db, input.entity, target.entityId, target.field))
        ?.id ?? null;
    const snapshot = sweepSnapshot.parse({
      input,
      target,
      fieldDecisionId,
    });
    const inputFingerprint = await sha256Hex(
      JSON.stringify({
        entity: input.entity,
        target,
        fieldDecisionId,
        model: input.model ?? null,
        taxonomy: input.taxonomyRevision,
        manifest,
      }),
    );
    await enqueueAiEvaluation(
      db,
      {
        runId,
        executionKind: "suggestion_sweep",
        shareKey: await sha256Hex(
          JSON.stringify({
            kind: "field",
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
          suggestionIds: [],
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
          model: input.model ?? null,
        },
        snapshot,
      },
      sequence,
    );
  }
  return targets.length;
}

export async function executeSuggestionSweepTarget(
  db: Database,
  item: ClaimedAiEvaluation,
  ports: SuggestionSweepPorts,
) {
  const snapshot = sweepSnapshot.parse(item.snapshot);
  const { input, target: queuedTarget, fieldDecisionId } = snapshot;
  const preparedFingerprint = await fieldInputFingerprint(
    db,
    input.entity,
    queuedTarget.entityId,
    queuedTarget.field,
  );
  const policy = decisionCatalogRows().find(
    (row) => row.entity === input.entity && row.field === queuedTarget.field,
  );
  if (!policy) throw new Error("Suggestion field policy no longer exists");
  const policyKeys = [
    ...policy.basis.map((row) => row.key),
    queuedTarget.field,
  ];
  const basisKeys = fieldSuggestionContextKeys(input.entity, policyKeys);
  const [record] = await readSelectedEntityRecords({
    context: ports.context,
    entity: input.entity,
    ids: [queuedTarget.id],
    fields: basisKeys,
  });
  if (!record) throw new Error("Suggestion target no longer exists");
  const valueOf = (key: string) => {
    if (!Object.hasOwn(entityFieldEnvelopeFields[input.entity], key))
      return record[key];
    const envelope = fieldEnvelopeFor(record, key);
    return envelope ? fieldValueOf(envelope) : null;
  };
  const targetEnvelope = fieldEnvelopeFor(record, queuedTarget.field);
  if (
    Object.hasOwn(
      entityFieldEnvelopeFields[input.entity],
      queuedTarget.field,
    ) &&
    (!targetEnvelope || targetEnvelope.result.kind === "missing")
  )
    throw new JobTargetError("Suggestion target field result is unavailable");
  const basis = Object.fromEntries(
    basisKeys.map((key) => [key, basisValueOf(valueOf(key))]),
  );
  const queuedBasis = Object.fromEntries(
    basisKeys.map((key) => [key, queuedTarget.basis[key] ?? null]),
  );
  if (
    canonicalJson(basis) !== canonicalJson(queuedBasis) ||
    (await fieldInputFingerprint(
      db,
      input.entity,
      queuedTarget.entityId,
      queuedTarget.field,
    )) !== preparedFingerprint
  )
    throw new Error("Suggestion basis changed after queuing");
  basis.__resolutionContext = fieldSuggestionResolutionContext(
    record.fields,
    policyKeys,
  );
  const target = { ...queuedTarget, basis };
  if (
    canonicalJson(z.json().parse(valueOf(target.field) ?? null)) !==
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
      model: captured.result.primary?.model ?? input.model ?? null,
    };
    saved = sweepResult.safeParse({
      ...captured.result,
      provenance,
    });
    if (!saved.success) throw saved.error;
    if (
      !(await storeAiEvaluationResult(
        db,
        item,
        JSON.parse(JSON.stringify(saved.data)),
      ))
    )
      throw new AiEvaluationAttemptObsoleteError();
  }
  const result = saved.data;
  await publishAiEvaluation(db, item.id, item.attemptToken, async (tx) => {
    if (
      (await fieldInputFingerprint(
        tx,
        input.entity,
        target.entityId,
        target.field,
      )) !== preparedFingerprint
    )
      throw new Error("Suggestion basis changed during inference");
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
  runId: RunId | null,
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
  model: string;
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
  };
}
