/**
 * The field Ask (ADR 0029 section 1): one decision-model question about one
 * saved record's field. Its declared input is what the `fields` reconciler
 * loaded: the record's stored basis and field columns and its precedents.
 * The producer reads the record through the canonical selected-detail reader
 * for labels and effective values, and refuses to answer when the stored
 * columns no longer equal the input, so an Answer always describes the input
 * its hash covers; the changed record files its own Ask.
 */
import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityRef, runEntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { prepareSavedField } from "~/server/ai/fields/prepare";
import { fieldPlan } from "~/server/ai/fields/repo/plan";
import {
  precedentLines,
  precedentSchema,
} from "~/server/ai/fields/repo/precedents";
import { aiRunOwner } from "~/server/ai/policy/call-owner";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { fieldJson, valueKey } from "~/server/ai/policy/field-rules";
import type { Database } from "~/server/db";
import { JobEvidenceObsoleteError } from "~/server/generic/jobs/errors";
import { lookupEntityLabels } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { defineAsk, type Produced } from "~/server/kernel/api";

import { readStoredColumns, storedReferenceId } from "./repo/stored-field";

export const fieldAskInput = z.object({
  entity: z.string(),
  field: z.string(),
  recordId: z.uuid(),
  /** The record's stored basis and field columns, by column key. */
  row: z.record(z.string(), z.json()),
  precedents: z.array(precedentSchema),
});
export type FieldAskInput = z.infer<typeof fieldAskInput>;

const proposalValue = z.object({
  /** The value as the column stores it (a reference's id). */
  value: z.string(),
  label: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const fieldAnswer = z.object({
  proposal: proposalValue
    .extend({ runnerUp: proposalValue.nullable() })
    .nullable(),
  /** Why there is or is not a proposal: `pick`, `none`, or a skip reason. */
  outcome: z.string(),
});
export type FieldAnswer = z.infer<typeof fieldAnswer>;

async function produceFieldAnswer(
  db: Database,
  input: FieldAskInput,
  runId: string | null,
): Promise<Produced<FieldAnswer>> {
  const plan = fieldPlan(input.entity, input.field);
  if (!plan)
    throw new Error(`${input.entity}.${input.field} is not a fields column`);
  const stored = await readStoredColumns(
    db,
    plan.entity,
    input.recordId,
    Object.keys(input.row),
  );
  if (
    !stored ||
    Object.entries(input.row).some(
      ([key, value]) => valueKey(fieldJson(stored[key])) !== valueKey(value),
    )
  )
    throw new JobEvidenceObsoleteError(
      "The record changed after Cubby read it; the new values file their own question",
    );
  const prepared = await prepareSavedField(
    db,
    input.entity,
    input.recordId,
    input.field,
  );
  if (!prepared)
    throw new JobEvidenceObsoleteError(
      "The record or its field result is unavailable",
    );
  const references = plan.field.reference;
  const labelById = new Map<string, string>();
  if (references) {
    const ids = input.precedents.flatMap((precedent) =>
      typeof precedent.value === "string" ? [precedent.value] : [],
    );
    const labels = ids.length
      ? await lookupEntityLabels(
          db,
          ids.map((id) => parseEntityRef(references, id)),
        )
      : new Map<string, string>();
    for (const id of ids) {
      const label = labels.get(entityRefKey(references, id));
      if (label) labelById.set(id, label);
    }
  }
  const operation = `suggestFields.${prepared.entity}.${input.field}`;
  const { result: evaluated, inputs } = await withAiInputs(false, () =>
    suggestFields(
      db,
      aiRunOwner(runId ? runEntityId.parse(runId) : null),
      {
        entity: prepared.entity,
        entityId: prepared.publicId,
        targets: [input.field],
        basisMode: "provided",
        basis: prepared.basis,
      },
      {
        recordId: input.recordId,
        precedentText: precedentLines(input.precedents, labelById),
      },
    ),
  );
  const model =
    [...inputs].reverse().find((call) => call.operation === operation)?.model ??
    null;
  const suggestion = evaluated.suggestions[input.field] ?? null;
  const outcome = evaluated.outcomes?.[input.field];
  const outcomeName =
    outcome?.kind === "evaluated"
      ? outcome.answer
      : (outcome?.reason ?? "none");
  const storedValue = async (value: string) =>
    references ? await storedReferenceId(db, references, value) : value;
  const proposal =
    suggestion?.value && suggestion.operation === "set"
      ? {
          value: await storedValue(suggestion.value),
          label: suggestion.label,
          confidence: suggestion.probability ?? 0,
          runnerUp: suggestion.alternatives[0]
            ? {
                value: await storedValue(suggestion.alternatives[0].value),
                label: suggestion.alternatives[0].label,
                confidence: suggestion.alternatives[0].probability,
              }
            : null,
        }
      : null;
  return {
    output: { proposal, outcome: outcomeName },
    model,
    tier: FIELD_SUGGESTION_FEATURE.tier,
  };
}

export const fieldAsk = defineAsk({
  feature: FIELD_SUGGESTION_FEATURE.feature,
  producer: "model",
  promptVersion: FIELD_SUGGESTION_FEATURE.promptVersion,
  input: fieldAskInput,
  output: fieldAnswer,
  policy: { tier: FIELD_SUGGESTION_FEATURE.tier },
  label: "Cubby's answer",
  produce: (input, context) =>
    produceFieldAnswer(context.db, input, context.runId),
});
