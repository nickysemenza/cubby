/**
 * The Decisions catalog's field rows: each `control.suggest` field's rules,
 * vocabulary and rendered prompt over a synthetic subject. Each prompt is
 * rendered by the live code path's builder (`classificationPrompt`,
 * `selectionPrompt`, `prunePrompt`, `buildChoiceInput`), never a copied
 * template. A reference or text target's choices are household records, so
 * its rendered input carries no roster.
 */
import type { DecisionCatalogRow } from "@cubby/schemas/ai";
import {
  entityFieldByKey,
  suggestFieldKeys,
} from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import {
  buildChoiceInput,
  classificationPrompt,
  type DecisionChoicePrompt,
  selectionPrompt,
} from "./decision-choice";
import type { AiDecisionFeature } from "./feature-identity";
import { FIELD_SUGGESTION_FEATURE } from "./features";
import {
  fieldSuggestDecisionFor,
  type FieldSuggestDecision,
  prunePrompt,
  type ResolvedBasis,
} from "./field-suggest";

export type CatalogRow = Omit<DecisionCatalogRow, "counts">;
type Option = DecisionCatalogRow["options"][number];

const suggestControlSchema = z
  .object({
    basis: z.array(z.string()),
    mode: z.enum(["fill", "prune"]),
    reviewRequired: z.boolean().default(false),
  })
  .passthrough();

const SYNTHETIC_TAG = "example tag";

export function featureFacts(feature: AiDecisionFeature) {
  return {
    feature: feature.feature,
    model: feature.model,
    promptVersion: feature.promptVersion,
  };
}

export function rendered(
  prompt: DecisionChoicePrompt,
): DecisionCatalogRow["prompt"] {
  return {
    subject: prompt.subject,
    input: z.json().parse(buildChoiceInput(prompt)),
  };
}

/** A synthetic basis the subject renderer formats like a real record's:
 * each basis field holds a plain example and the prune target's own array. */
function syntheticBasis(
  basis: readonly { key: string; label: string }[],
  pruneKey: string | null,
): ResolvedBasis {
  return Object.fromEntries(
    basis.map(({ key, label }) => [
      key,
      key === pruneKey
        ? JSON.stringify([SYNTHETIC_TAG])
        : `Example ${label.toLowerCase()}`,
    ]),
  );
}

function fieldPrompt(
  spec: FieldSuggestDecision,
  basis: ResolvedBasis,
): DecisionChoicePrompt {
  switch (spec.kind) {
    case "enum":
      return classificationPrompt({
        subject: spec.subject(basis),
        rules: spec.rules,
        values: spec.values,
        allowNone: spec.allowNone,
        describe: (value) => spec.describe(value),
      });
    case "prune":
      return prunePrompt(spec, basis, SYNTHETIC_TAG);
    case "reference":
    case "text":
      return selectionPrompt(
        { rules: spec.rules, renderLine: String },
        spec.subject(basis),
        [],
      );
  }
}

function fieldOptions(spec: FieldSuggestDecision): Option[] {
  if (spec.kind !== "enum") return [];
  return spec.values.map((value) => ({
    value,
    label: spec.labelOf?.(value) ?? value,
    description: spec.describe(value),
  }));
}

function fieldRow(key: (typeof suggestFieldKeys)[number]): CatalogRow {
  const [rawEntity = "", field = ""] = key.split(".");
  const entity = z.enum(shortcodeEntities).parse(rawEntity);
  const fieldModel = entityFieldByKey(entity, field);
  const suggest = suggestControlSchema
    .nullable()
    .parse(fieldModel?.control?.suggest ?? null);
  const spec = fieldSuggestDecisionFor(entity, field);
  if (!fieldModel || !suggest || !spec)
    throw new Error(`Suggest field ${key} has no manifest or registry entry`);
  const basis = suggest.basis.map((basisKey) => ({
    key: basisKey,
    label: entityFieldByKey(entity, basisKey)?.label ?? basisKey,
  }));
  const prompt = fieldPrompt(
    spec,
    syntheticBasis(basis, spec.kind === "prune" ? spec.arrayKey : null),
  );
  return {
    key,
    entity,
    field,
    label: fieldModel.label,
    description: fieldModel.description,
    ...featureFacts(FIELD_SUGGESTION_FEATURE),
    mode: suggest.mode,
    choiceKind: spec.kind,
    basis,
    options: fieldOptions(spec),
    roster:
      spec.kind === "reference"
        ? { entity: spec.entity, maxCandidates: spec.maxCandidates }
        : spec.kind === "text"
          ? { entity: null, maxCandidates: spec.maxCandidates }
          : null,
    rules: prompt.rules,
    reviewRequired: suggest.reviewRequired,
    prompt: rendered(prompt),
  };
}

export function fieldDecisionRows(): CatalogRow[] {
  return suggestFieldKeys.map(fieldRow);
}
