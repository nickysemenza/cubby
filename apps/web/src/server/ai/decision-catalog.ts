/**
 * `ai.decisionCatalog`: every decision Cubby asks Jev/Clef, with the prompt
 * the live call would send, rendered by the live code path over a synthetic
 * subject. Field rows come from `ai/policy/field-decisions.ts`; Try runs a
 * real record.
 */
import type { DecisionCatalogRow, SuggestionCountRow } from "@cubby/schemas/ai";
import { externalIdKind } from "@cubby/schemas/external-id";
import { extractedPurchaseLine } from "@cubby/schemas/purchase-import";

import { externalIdKindSubject } from "~/server/ai/external-id-kind";
import {
  classificationPrompt,
  type DecisionChoicePrompt,
  selectionPrompt,
} from "~/server/ai/policy/decision-choice";
import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/policy/feature-identity";
import {
  PURCHASE_LINE_DECISIONS,
  type AiDecisionFeature,
  FIELD_SUGGESTION_FEATURE,
  INGREDIENT_MERGE_FEATURE,
  MAILBOX_TRIAGE_FEATURE,
  MAIL_ATTACHMENT_PURPOSE_FEATURE,
  UPC_OFFER_COMPARABILITY_FEATURE,
  IMAGE_PROVENANCE_CLASSIFICATION_FEATURE,
  PRODUCT_VARIANT_RELATION_FEATURE,
  SETTLEMENT_CANDIDATE_RANK_FEATURE,
  USDA_FOOD_SUGGEST_FEATURE,
} from "~/server/ai/policy/features";
import {
  type CatalogRow,
  featureFacts,
  fieldDecisionRows,
  rendered,
} from "~/server/ai/policy/field-decisions";
import {
  renderSettlementSubject,
  settlementSelectionSpec,
} from "~/server/ai/settlement-candidate-rank";
import {
  EXTERNAL_ID_KIND_DESCRIPTIONS,
  EXTERNAL_ID_KIND_RULES,
} from "~/server/ai/vocabularies";
import type { Database } from "~/server/db";
import { suggestionCounts } from "~/server/generic/assessment/repo/suggestion-review";

import { productIdentityPrompt } from "./product-identity";

type Option = DecisionCatalogRow["options"][number];

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
  const triage = MAILBOX_TRIAGE_FEATURE.prompt(
    JSON.stringify({
      headers: { subject: "Example order confirmation" },
      body: "Your order for a cordless drill kit is confirmed. Total $79.95 USD.",
      attachments: [],
    }),
  );
  const lineRows = Object.entries(PURCHASE_LINE_DECISIONS).map(
    ([stage, spec]) =>
      featureRow(
        spec.feature,
        `Purchase line ${stage}`,
        "One purchase-import line decision",
        spec,
        spec.prompt(syntheticLine),
        { options: plainOptions(spec.choices) },
      ),
  );
  return [
    featureRow(
      UPC_OFFER_COMPARABILITY_FEATURE.feature,
      "UPC offer comparability",
      "Compare one offer with the identified sellable package",
      UPC_OFFER_COMPARABILITY_FEATURE,
      UPC_OFFER_COMPARABILITY_FEATURE.prompt({
        itemTitle: "Example flour, 5 lb, pack of 4",
        offerTitle: "Example flour, 5 lb, single bag",
      }),
      { options: plainOptions(UPC_OFFER_COMPARABILITY_FEATURE.choices) },
    ),
    featureRow(
      IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.feature,
      "Image provenance",
      "Classify weak image-origin metadata",
      IMAGE_PROVENANCE_CLASSIFICATION_FEATURE,
      IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.prompt({
        filename: "image.jpg",
        width: 1200,
        height: 1200,
        sourceAssetUrl: "https://catalog.example/image.jpg",
        sourcePageUrl: "https://catalog.example/item",
        sourceName: "Example catalog",
        sightingSourceTypes: [],
        hasExifCamera: false,
        hasExifCaptureTime: false,
        analysisSummary: null,
      }),
      {
        options: plainOptions(IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.choices),
      },
    ),
    featureRow(
      PRODUCT_VARIANT_RELATION_FEATURE.feature,
      "Product variants",
      "Compare color and size from original title evidence",
      PRODUCT_VARIANT_RELATION_FEATURE,
      PRODUCT_VARIANT_RELATION_FEATURE.prompt({
        firstTitle: "Example trail shirt, navy, medium",
        secondTitle: "Example trail shirt, navy, large",
      }),
      { options: plainOptions(PRODUCT_VARIANT_RELATION_FEATURE.choices) },
    ),
    featureRow(
      PRODUCT_IDENTITY_FEATURE.feature,
      "Product identity",
      "Compare one pair against exact identifiers and verified variant evidence",
      PRODUCT_IDENTITY_FEATURE,
      productIdentityPrompt("Two synthetic Product records"),
    ),
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
      MAIL_ATTACHMENT_PURPOSE_FEATURE.feature,
      "Email attachment purpose",
      "Choose whether one retained Email file belongs on a Purchase",
      MAIL_ATTACHMENT_PURPOSE_FEATURE,
      MAIL_ATTACHMENT_PURPOSE_FEATURE.prompt(
        JSON.stringify({
          email: {
            subject: "Shipping paperwork",
            bodyText: "Attached is the receipt for your postage purchase.",
          },
          attachment: {
            filename: "document.pdf",
            mimeType: "application/pdf",
            checksum: "synthetic-checksum",
          },
        }),
      ),
      { options: plainOptions(MAIL_ATTACHMENT_PURPOSE_FEATURE.choices) },
    ),
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
      selectionPrompt(
        USDA_FOOD_SUGGEST_FEATURE.selection,
        USDA_FOOD_SUGGEST_FEATURE.subject("Example flour"),
        [],
      ),
      {
        roster: {
          entity: null,
          maxCandidates: USDA_FOOD_SUGGEST_FEATURE.selection.maxCandidates,
        },
      },
    ),
    featureRow(
      INGREDIENT_MERGE_FEATURE.feature,
      "Ingredient merge",
      "Choose an existing ingredient to merge into",
      INGREDIENT_MERGE_FEATURE,
      selectionPrompt(
        INGREDIENT_MERGE_FEATURE.selection,
        INGREDIENT_MERGE_FEATURE.subject("Example flour"),
        [],
      ),
      {
        roster: {
          entity: "ingredient",
          maxCandidates: INGREDIENT_MERGE_FEATURE.selection.maxCandidates,
        },
      },
    ),
  ];
}

/** The catalog without counts: pure, so its coverage is unit-tested. */
export function decisionCatalogRows(): CatalogRow[] {
  return [...fieldDecisionRows(), ...featureRows()];
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
