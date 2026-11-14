/**
 * The field Ask's producer: the saved-record decision question for one
 * field, asked only while the record's stored columns equal the Ask's input.
 * A stale input is refused before any model call, so its Ask re-queues.
 */
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityRef, runEntityId } from "@cubby/schemas/identifiers";

import { withAiInputs } from "~/server/ai/evaluation-inputs";
import {
  suggestFields,
  resolveFieldReferenceLabels,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import {
  prepareSavedFields,
  type PreparedField,
} from "~/server/ai/fields/prepare";
import { fieldPlan } from "~/server/ai/fields/repo/plan";
import { precedentLines } from "~/server/ai/fields/repo/precedents";
import { aiRunOwner } from "~/server/ai/policy/call-owner";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { fieldJson, valueKey } from "~/server/ai/policy/field-rules";
import type { Database } from "~/server/db";
import { lookupEntityLabels } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { Produced } from "~/server/kernel/api";
import { refusedBeforeSending } from "~/server/kernel/produce-ledger";
import { WorkEvidenceObsoleteError } from "~/server/kernel/work-errors";

import type { FieldAskInput } from "./ask";
import type { FieldAnswer } from "./repo/field-answer";
import { readStoredRows, storedReferenceId } from "./repo/stored-field";

async function unchangedFieldInputs(
  db: Database,
  inputs: readonly FieldAskInput[],
) {
  const groups = new Map<
    string,
    {
      plan: NonNullable<ReturnType<typeof fieldPlan>>["entity"];
      inputs: FieldAskInput[];
    }
  >();
  for (const input of inputs) {
    const plan = fieldPlan(input.entity, input.field);
    if (!plan)
      throw new Error(`${input.entity}.${input.field} is not a fields column`);
    const group = groups.get(input.entity) ?? { plan: plan.entity, inputs: [] };
    group.inputs.push(input);
    groups.set(input.entity, group);
  }
  const unchanged = new Set<FieldAskInput>();
  for (const group of groups.values()) {
    const rows = await readStoredRows(
      db,
      group.plan,
      [...new Set(group.inputs.map((input) => input.recordId))],
      [...new Set(group.inputs.flatMap((input) => Object.keys(input.row)))],
    );
    for (const input of group.inputs) {
      const stored = rows.get(input.recordId);
      if (
        stored &&
        Object.entries(input.row).every(
          ([key, value]) =>
            valueKey(fieldJson(stored[key])) === valueKey(value),
        )
      )
        unchanged.add(input);
    }
  }
  return unchanged;
}

export async function produceFieldAnswer(
  db: Database,
  input: FieldAskInput,
  runId: string | null,
): Promise<Produced<FieldAnswer>> {
  if (!input.questions)
    throw refusedBeforeSending(
      new Error("The field question has no prepared model inputs"),
    );
  if (!(await unchangedFieldInputs(db, [input])).has(input))
    throw refusedBeforeSending(
      new WorkEvidenceObsoleteError(
        "The record changed after Cubby read it; the new values file their own question",
      ),
    );
  const [prepared] = await prepareSavedFields(db, [input]);
  if (!prepared)
    throw refusedBeforeSending(
      new WorkEvidenceObsoleteError(
        "The record or its field result is unavailable",
      ),
    );
  return evaluateField(db, input, runId, prepared, false);
}

/** Prepare tracked rows together; admission is checked again before a producer call. */
export async function prepareFieldQuestions(
  db: Database,
  inputs: readonly FieldAskInput[],
): Promise<NonNullable<FieldAskInput["questions"]>[]> {
  const unchanged = await unchangedFieldInputs(db, inputs);
  const current = inputs.filter((input) => unchanged.has(input));
  const prepared = await prepareSavedFields(db, current);
  const byInput = new Map(
    current.map((input, index) => [input, prepared[index]]),
  );
  const codes = new Set<string>();
  for (const field of prepared) {
    if (!field) continue;
    for (const model of entityFieldModels[field.entity].fields) {
      const code = field.basis[model.key];
      if (model.reference && code) codes.add(code);
    }
  }
  const labels = await resolveFieldReferenceLabels(db, [...codes]);
  const resolveLabels: NonNullable<SuggestFieldsPorts["resolveLabels"]> = (
    readDb,
    wanted,
  ) =>
    wanted.every((code) => codes.has(code))
      ? Promise.resolve(labels)
      : resolveFieldReferenceLabels(readDb, wanted);
  return Promise.all(
    inputs.map(async (input) => {
      const basis = byInput.get(input);
      if (!basis) return [];
      const result = await evaluateField(
        db,
        input,
        null,
        basis,
        true,
        resolveLabels,
      );
      return result.output.questions ?? [];
    }),
  );
}

async function evaluateField(
  db: Database,
  input: FieldAskInput,
  runId: string | null,
  prepared: PreparedField,
  prepareOnly: boolean,
  resolveLabels?: SuggestFieldsPorts["resolveLabels"],
): Promise<
  Produced<
    FieldAnswer & { questions?: NonNullable<FieldAskInput["questions"]> }
  >
> {
  const plan = fieldPlan(input.entity, input.field);
  if (!plan)
    throw new Error(`${input.entity}.${input.field} is not a fields column`);
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
          resolveLabels,
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
  const currentEntries = input.row[input.field];
  const removed = new Set(
    suggestion?.removals.map((entry) => entry.value) ?? [],
  );
  const proposal =
    suggestion?.operation === "remove" &&
    removed.size &&
    Array.isArray(currentEntries)
      ? {
          value: currentEntries.filter(
            (entry): entry is string =>
              typeof entry === "string" && !removed.has(entry),
          ),
          label: null,
          confidence: Math.min(
            ...suggestion.removals.map((entry) => entry.probability),
          ),
          runnerUp: null,
        }
      : suggestion?.value && suggestion.operation === "set"
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
