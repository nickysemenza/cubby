/**
 * `ai.decisionCatalog`: every decision Cubby asks Jev/Clef, with the prompt
 * the live call would send. Each prompt is rendered by the live code path
 * (registry subject renderers, `classificationPrompt`, `selectionPrompt`,
 * `prunePrompt`, `buildChoiceInput`) over a synthetic subject, never a copied
 * template. A reference or text target's choices are household records, so
 * its rendered input carries no roster; Try runs a real record.
 */
import type { DecisionCatalogRow, SuggestionCountRow } from "@cubby/schemas/ai";
import {
  entityFieldByKey,
  suggestFieldKeys,
} from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { externalIdKind } from "@cubby/schemas/external-id";
import { extractedPurchaseLine } from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { classificationPrompt } from "~/server/ai/classify";
import {
  buildChoiceInput,
  type DecisionChoicePrompt,
} from "~/server/ai/decision-model";
import { externalIdKindSubject } from "~/server/ai/external-id-kind";
import {
  type AiDecisionFeature,
  FIELD_SUGGESTION_FEATURE,
  INGREDIENT_MERGE_FEATURE,
  MAILBOX_TRIAGE_FEATURE,
  SETTLEMENT_CANDIDATE_RANK_FEATURE,
  USDA_FOOD_SUGGEST_FEATURE,
} from "~/server/ai/features";
import {
  fieldSuggestSpecFor,
  type FieldSuggestSpec,
  type ResolvedBasis,
} from "~/server/ai/field-suggest/registry";
import { prunePrompt } from "~/server/ai/field-suggest/suggest-fields";
import { selectionPrompt } from "~/server/ai/selection";
import {
  renderSettlementSubject,
  settlementSelectionSpec,
} from "~/server/ai/settlement-candidate-rank";
import {
  EXTERNAL_ID_KIND_DESCRIPTIONS,
  EXTERNAL_ID_KIND_RULES,
} from "~/server/ai/vocabularies";
import type { Database } from "~/server/db";
import { mailTriagePrompt } from "~/server/purchase-import/gmail/triage";
import {
  lineDecisionSubject,
  PURCHASE_LINE_DECISIONS,
} from "~/server/purchase-import/writer";
import { suggestionCounts } from "~/server/repo/suggestion-review";
import { ingredientMergeSubject } from "~/server/services/ai-enrichment/ingredient-merge";
import { ingredientMergeSpec } from "~/server/services/ai-enrichment/merge-shortlist";
import { usdaMatchSubject } from "~/server/services/ai-enrichment/usda-match";
import { usdaFoodSpec } from "~/server/services/ai-enrichment/usda-shortlist";

type CatalogRow = Omit<DecisionCatalogRow, "counts">;
type Option = DecisionCatalogRow["options"][number];

const suggestControlSchema = z
  .object({
    basis: z.array(z.string()),
    mode: z.enum(["fill", "prune"]),
    reviewRequired: z.boolean().default(false),
  })
  .passthrough();

const SYNTHETIC_TAG = "example tag";

function featureFacts(feature: AiDecisionFeature) {
  return {
    feature: feature.feature,
    model: feature.model,
    promptVersion: feature.promptVersion,
  };
}

function rendered(prompt: DecisionChoicePrompt): DecisionCatalogRow["prompt"] {
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
  spec: FieldSuggestSpec,
  basis: ResolvedBasis,
): DecisionChoicePrompt {
  switch (spec.kind) {
    case "enum":
      return classificationPrompt({
        subject: spec.subject(basis),
        rules: spec.rules,
        values: spec.values,
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

function fieldOptions(spec: FieldSuggestSpec): Option[] {
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
  const spec = fieldSuggestSpecFor(entity, field);
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

const plainOptions = (values: readonly string[]): Option[] =>
  values.map((value) => ({ value, label: value, description: null }));

function featureRow(
  key: string,
  label: string,
  description: string,
  feature: AiDecisionFeature,
  prompt: DecisionChoicePrompt,
  extra: Partial<Pick<CatalogRow, "options" | "roster">> = {},
): CatalogRow {
  return {
    key,
    entity: null,
    field: null,
    label,
    description,
    ...featureFacts(feature),
    mode: "choice",
    choiceKind: "choice",
    basis: [],
    options: extra.options ?? [],
    roster: extra.roster ?? null,
    rules: prompt.rules,
    reviewRequired: true,
    prompt: rendered(prompt),
  };
}

const syntheticLine = extractedPurchaseLine.parse({
  title: "Cordless drill kit",
  amount: 79.95,
  quantity: 1,
  sku: "DRILL-20",
});

function featureRows(): CatalogRow[] {
  const triage = mailTriagePrompt(
    JSON.stringify({
      headers: { subject: "Example order confirmation" },
      body: "Your order for a cordless drill kit is confirmed. Total $79.95 USD.",
      attachments: [],
    }),
  );
  const lineRows = Object.entries(PURCHASE_LINE_DECISIONS).map(
    ([stage, spec]) =>
      featureRow(
        spec.feature.feature,
        `Purchase line ${stage}`,
        "One purchase-import line decision",
        spec.feature,
        {
          subject: lineDecisionSubject(syntheticLine),
          rules: spec.rules,
          choices: spec.choices,
          allowNone: false,
        },
        { options: plainOptions(spec.choices) },
      ),
  );
  return [
    featureRow(
      MAILBOX_TRIAGE_FEATURE.feature,
      "Mail triage",
      "Route an original Email: related, unrelated or uncertain",
      MAILBOX_TRIAGE_FEATURE,
      triage,
      { options: plainOptions(triage.choices) },
    ),
    ...lineRows,
    featureRow(
      SETTLEMENT_CANDIDATE_RANK_FEATURE.feature,
      "Settlement tie-break",
      "Order statement charges tied for a Purchase",
      SETTLEMENT_CANDIDATE_RANK_FEATURE,
      selectionPrompt(
        settlementSelectionSpec,
        renderSettlementSubject({
          vendorName: "Example Hardware",
          date: "2026-03-03",
          statedTotal: 42.5,
          orderId: "1001",
        }),
        [],
      ),
      {
        roster: {
          entity: "financialTransaction",
          maxCandidates: settlementSelectionSpec.maxCandidates,
        },
      },
    ),
    featureRow(
      "external-id-kind",
      "External ID kind",
      "Classify a product identifier's kind",
      FIELD_SUGGESTION_FEATURE,
      classificationPrompt({
        subject: externalIdKindSubject({
          source: "manufacturer",
          identifier: "DRILL-20",
          url: null,
          productName: "Cordless drill",
          manufacturer: "Example Tools",
        }),
        rules: EXTERNAL_ID_KIND_RULES,
        values: externalIdKind.options,
        describe: (value) => EXTERNAL_ID_KIND_DESCRIPTIONS[value],
      }),
      {
        options: externalIdKind.options.map((value) => ({
          value,
          label: value,
          description: EXTERNAL_ID_KIND_DESCRIPTIONS[value],
        })),
      },
    ),
    featureRow(
      USDA_FOOD_SUGGEST_FEATURE.feature,
      "USDA food",
      "Choose one USDA food for an ingredient",
      USDA_FOOD_SUGGEST_FEATURE,
      selectionPrompt(usdaFoodSpec, usdaMatchSubject("Example flour"), []),
      { roster: { entity: null, maxCandidates: usdaFoodSpec.maxCandidates } },
    ),
    featureRow(
      INGREDIENT_MERGE_FEATURE.feature,
      "Ingredient merge",
      "Choose an existing ingredient to merge into",
      INGREDIENT_MERGE_FEATURE,
      selectionPrompt(
        ingredientMergeSpec,
        ingredientMergeSubject("Example flour"),
        [],
      ),
      {
        roster: {
          entity: "ingredient",
          maxCandidates: ingredientMergeSpec.maxCandidates,
        },
      },
    ),
  ];
}

/** The catalog without counts: pure, so its coverage is unit-tested. */
export function decisionCatalogRows(): CatalogRow[] {
  return [...suggestFieldKeys.map(fieldRow), ...featureRows()];
}

export async function decisionCatalog(
  db: Database,
): Promise<DecisionCatalogRow[]> {
  const counts = new Map<string, SuggestionCountRow>(
    (await suggestionCounts(db)).map((row) => [
      `${row.entity}.${row.field}`,
      row,
    ]),
  );
  return decisionCatalogRows().map((row) => {
    const stored = row.field === null ? null : counts.get(row.key);
    return {
      ...row,
      counts:
        row.field === null
          ? null
          : {
              pending: stored?.pending ?? 0,
              applied: stored?.applied ?? 0,
              rejected: stored?.rejected ?? 0,
              superseded: stored?.superseded ?? 0,
            },
    };
  });
}
