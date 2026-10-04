import type { DisplayItem } from "@cubby/schemas/entity-definitions/label-field";
import type {
  FinancialAccountCardNumber,
  FinancialAccountSourceAlias,
} from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionSourceRef,
  MerchantVendorInference,
} from "@cubby/schemas/financial-transaction";
import type { ImageProvenanceEvidence } from "@cubby/schemas/image-capture-fields";
import type { NutritionTotals } from "@cubby/schemas/nutrition";
import type { WishCandidateOut } from "@cubby/schemas/wish";

import { formatCurrency } from "~/lib/number-format";
import { estimateLabel } from "~/server/repo/list-display-labels";

/**
 * Server-owned detail text for structured values a client would otherwise
 * re-word. Each function backs one field's `display.detailLabelPath` or
 * `display.itemsPath`: web and native print what the record carries, while the
 * structured value stays the editable source. A `null` label means the row is
 * empty. Lines are joined with "\n"; a client draws them as written.
 */

const joined = (parts: readonly string[], separator: string): string | null =>
  parts.length > 0 ? parts.join(separator) : null;

/** A category's ancestry, root first. */
export const categoryPathLabel = (
  path: readonly { name: string }[],
): string | null =>
  joined(
    path.map((node) => node.name),
    " / ",
  );

export const sourceAliasesLabel = (
  aliases: readonly FinancialAccountSourceAlias[],
): string | null =>
  joined(
    aliases.map((alias) => `${alias.source}: ${alias.alias}`),
    ", ",
  );

export const sourceRefsLabel = (
  refs: readonly Pick<FinancialTransactionSourceRef, "source" | "externalId">[],
): string | null =>
  joined(
    refs.map((ref) => `${ref.source}: ${ref.externalId}`),
    ", ",
  );

/** One line per card: digits, kind, the dates it was valid (an open end is "…"), and its note. */
export const cardNumbersLabel = (
  cards: readonly FinancialAccountCardNumber[],
): string | null =>
  joined(
    cards.map((card) =>
      [
        `•••• ${card.last4}`,
        card.kind.replaceAll("_", " "),
        card.validFrom || card.validTo
          ? `${card.validFrom ?? "…"} → ${card.validTo ?? "…"}`
          : null,
        card.note,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    "\n",
  );

export const agentHintsLabel = (hints: {
  ordersListUrl: string | null;
  pagination: string | null;
  orderLinkPattern: string | null;
  notes: readonly string[];
}): string | null =>
  joined(
    [
      hints.ordersListUrl && `Orders: ${hints.ordersListUrl}`,
      hints.pagination && `Pagination: ${hints.pagination}`,
      hints.orderLinkPattern && `Order links: ${hints.orderLinkPattern}`,
      ...hints.notes,
    ].filter((part): part is string => Boolean(part)),
    "\n",
  );

const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

/** What a recipe holds, for the scan before opening its body. */
export const recipeCompositionLabel = (
  sections: readonly {
    ingredients: readonly unknown[];
    instructions: readonly unknown[];
  }[],
): string =>
  [
    count(sections.length, "section"),
    count(
      sections.reduce(
        (total, section) => total + section.ingredients.length,
        0,
      ),
      "ingredient",
    ),
    count(
      sections.reduce(
        (total, section) => total + section.instructions.length,
        0,
      ),
      "step",
    ),
  ].join(" · ");

/** The recipe's cost and calories, each with its range and confidence language intact. */
export const recipeTotalsLabel = (
  totals:
    | (Pick<NutritionTotals, "cost"> & {
        nutrition: Pick<NutritionTotals["nutrition"], "kcal">;
      })
    | null
    | undefined,
): string | null =>
  totals
    ? [
        estimateLabel(totals.cost, "cost"),
        estimateLabel(totals.nutrition.kcal, "kcal"),
      ].join(" · ")
    : null;

export const provenanceEvidenceLabel = (
  evidence: ImageProvenanceEvidence | null | undefined,
): string | null =>
  evidence
    ? [evidence.basis, evidence.ruleId, evidence.detail]
        .filter(Boolean)
        .join(" · ")
    : null;

/**
 * The vendor a card line probably came from, only while the inference is worth
 * showing: a single prior match (`insufficient_history`) or none says nothing.
 */
export const possibleVendorLabel = (
  inference: Pick<MerchantVendorInference, "status" | "candidates"> | null,
): string | null =>
  inference?.status === "suggested" || inference?.status === "ambiguous"
    ? joined(
        inference.candidates.map((candidate) => candidate.vendorName),
        ", ",
      )
    : null;

/** A wish's candidate products, one row each opening the product. */
export const wishCandidateItems = (
  candidates: readonly WishCandidateOut[],
): DisplayItem[] =>
  candidates.map((candidate) => ({
    entity: "product",
    id: candidate.id,
    title: candidate.name,
    subtitle: [candidate.manufacturer, candidate.model]
      .filter(Boolean)
      .join(" · "),
    trailing:
      [
        candidate.price !== null ? formatCurrency(candidate.price) : null,
        candidate.inventoried ? "In inventory" : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  }));
