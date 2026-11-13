/**
 * The field Ask's producer: the saved-record decision question for one
 * field, asked only while the record's stored columns equal the Ask's input.
 */
import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityRef, runEntityId } from "@cubby/schemas/identifiers";

import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { prepareSavedField } from "~/server/ai/fields/prepare";
import { fieldPlan } from "~/server/ai/fields/repo/plan";
import { precedentLines } from "~/server/ai/fields/repo/precedents";
import { aiRunOwner } from "~/server/ai/policy/call-owner";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { fieldJson, valueKey } from "~/server/ai/policy/field-rules";
import type { Database } from "~/server/db";
import { JobEvidenceObsoleteError } from "~/server/generic/jobs/errors";
import { lookupEntityLabels } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { Produced } from "~/server/kernel/api";

import type { FieldAnswer, FieldAskInput } from "./ask";
import { readStoredColumns, storedReferenceId } from "./repo/stored-field";

export async function produceFieldAnswer(
  db: Database,
  input: FieldAskInput,
  runId: string | null,
  prepareOnly = false,
): Promise<
  Produced<
    FieldAnswer & {
      questions?: import("zod").z.infer<
        typeof import("~/server/ai/evaluation-inputs").preparedQuestion
      >[];
    }
  >
> {
  if (!prepareOnly && !input.questions)
    throw new JobEvidenceObsoleteError(
      "The field question has no prepared model inputs",
    );
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
  const captured = await withAiInputs(
    prepareOnly,
    () =>
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
          applicationCache: false,
          decisionModel: FIELD_SUGGESTION_FEATURE.model,
          recordId: input.recordId,
          precedentText: precedentLines(input.precedents, labelById),
        },
      ),
    { providerFree: true, expected: prepareOnly ? undefined : input.questions },
  );
  const { result: evaluated, inputs } = captured;
  if (prepareOnly)
    return {
      output: {
        proposal: null,
        outcome: "prepared",
        questions: captured.questions,
      },
      model: null,
    };
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
