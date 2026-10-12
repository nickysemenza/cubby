import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  entitySummary,
  type EntitySummary,
} from "@cubby/schemas/entity-summary";
import type { LocationValuation } from "@cubby/schemas/location";
import type {
  MeasureEstimate,
  NutritionTotals,
} from "@cubby/schemas/nutrition";
import type { ProductQuantityLedgerOut } from "@cubby/schemas/product";
import type { PurchaseReconciliation } from "@cubby/schemas/purchase";
import type { RecipeTimes } from "@cubby/schemas/recipe";

import {
  formatCount,
  formatCurrency,
  formatCurrencyRange,
} from "~/lib/number-format";
import { formatEstimate } from "~/lib/nutrition-format";
import type { PerUnitPrices } from "~/lib/price-mapping-utils";
import { formatRecipeTime } from "~/lib/recipe-time";
import { formatPerUnitPrice } from "~/lib/unit-price-format";

/**
 * Server-owned list-cell text for figures a client would otherwise re-derive.
 * Each function backs one field's `display.labelPath`: web and native print
 * the string, while the field's own value stays the sort and filter value.
 * A `null` label means the cell is empty.
 */

/**
 * Units bought minus units gone, with its own uncertainty attached. The
 * `+N?` / `−N?` suffixes are load-bearing: an expense line with no recorded
 * quantity contributes nothing to the number, so a product with unquantified
 * receipts would otherwise read as a confident count. Both directions are
 * disclosed — an unknown acquisition means the real count could be higher, an
 * unknown exit that it could be lower.
 */
export const expectedQuantityLabel = (
  ledger: Pick<
    ProductQuantityLedgerOut,
    "expectedQuantity" | "unknownAcquisitionLines" | "unknownExitLines"
  >,
): string =>
  [
    String(ledger.expectedQuantity),
    ledger.unknownAcquisitionLines > 0
      ? `+${ledger.unknownAcquisitionLines}?`
      : null,
    ledger.unknownExitLines > 0 ? `−${ledger.unknownExitLines}?` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");

/** Shelf minus ledger, signed so a surplus reads differently from a deficit. */
export const quantityVarianceLabel = (
  variance: number | null,
): string | null =>
  variance === null ? null : variance > 0 ? `+${variance}` : String(variance);

/** A recipe or meal total, with its range and confidence language intact. */
export const estimateLabel = (
  estimate: MeasureEstimate,
  metric: "cost" | "kcal",
): string =>
  metric === "cost"
    ? formatEstimate(estimate, "cost")
    : formatEstimate(estimate, "kcal", "kcal");

export const mealCostLabel = (cost: MeasureEstimate): string =>
  estimateLabel(cost, "cost");

export const totalTimeLabel = (
  times: Pick<RecipeTimes, "total" | "totalMinutes"> | null | undefined,
): string | null => formatRecipeTime(times?.total, times?.totalMinutes);

/** The three computed recipe columns: Cost, Calories and Time. */
export const recipeListLabels = (recipe: {
  totals?: NutritionTotals | null;
  meta?: { times?: Pick<RecipeTimes, "total" | "totalMinutes"> | null } | null;
}) => ({
  costTotalLabel: recipe.totals
    ? estimateLabel(recipe.totals.cost, "cost")
    : null,
  caloriesTotalLabel: recipe.totals
    ? estimateLabel(recipe.totals.nutrition.kcal, "kcal")
    : null,
  totalMinutesLabel: totalTimeLabel(recipe.meta?.times),
});

export const unitPriceLabel = (
  prices: PerUnitPrices | null | undefined,
): string | null =>
  prices?.natural ? formatPerUnitPrice(prices.natural) : null;

/**
 * A $0.00 total means "empty" or "nothing priced", never a real value, so the
 * label is absent and the pricing caveat goes with it.
 */
export const valuationLabel = (
  valuation:
    | (Pick<LocationValuation, "directValuation"> & {
        direct: { missingPricing: number; miscNoPrice: number };
      })
    | null
    | undefined,
): string | null => {
  if (!valuation || valuation.directValuation === 0) return null;
  const caveat = [
    valuation.direct.missingPricing > 0
      ? `no pricing for ${valuation.direct.missingPricing}`
      : null,
    valuation.direct.miscNoPrice > 0
      ? `${valuation.direct.miscNoPrice} misc`
      : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  const total = formatCurrency(valuation.directValuation);
  return caveat ? `${total} (${caveat})` : total;
};

export const expenseCountLabel = (count: number, unpriced: number): string =>
  unpriced > 0 ? `${count} · ${unpriced} unpriced` : String(count);

const RECONCILIATION_LABELS = {
  // Covers both reconcilePurchase "unknown" cases: no stated total to compare
  // against, and no Expense lines to compare with.
  unknown: "Nothing to reconcile",
  match: "Reconciles",
  refund_adjusted: "Refund-adjusted",
  mismatch: "Needs review",
} satisfies Record<PurchaseReconciliation, string>;

/**
 * The verdict is the row's own `reconciliation` (from `reconcilePurchase`);
 * only a verdict that disagrees with the stated total carries the gap.
 */
export const reconciliationLabel = (purchase: {
  statedTotal: number | null;
  expenseTotal: number;
  reconciliation: PurchaseReconciliation;
}): string => {
  const label = RECONCILIATION_LABELS[purchase.reconciliation];
  const hasGap =
    purchase.reconciliation === "mismatch" ||
    purchase.reconciliation === "refund_adjusted";
  return hasGap && purchase.statedTotal !== null
    ? `${label} ${formatCurrency(purchase.expenseTotal - purchase.statedTotal)}`
    : label;
};

const settlementOptions =
  entityFieldModels.purchase.fields.find(
    (field) => field.key === "financialReconciliation",
  )?.display.valueOptions ?? [];

/** Settlement status from the declared roster, beside how many entries back it. */
export const settlementLabel = (settlement: {
  status: string;
  transactionCount: number;
}): string =>
  `${settlementOptions.find((option) => option.value === settlement.status)?.label ?? settlement.status} · ${settlement.transactionCount}`;

type ListTotal = EntitySummary["list"]["totals"][number];

const listTotalLabel = (
  total: ListTotal,
  sums: Readonly<Record<string, number>>,
): string | null => {
  const values: number[] = [];
  for (const key of total.keys) {
    const value = sums[key];
    if (value === undefined || !Number.isFinite(value)) return null;
    values.push(value);
  }
  const [first, second] = values;
  if (first === undefined) return null;
  switch (total.format) {
    case "currency":
      return formatCurrency(first);
    case "currencyRange":
      return formatCurrencyRange(first, second);
    case "integer":
      return formatCount(first);
  }
};

/**
 * The declared list totals as text, keyed by total id, over the server's
 * full-filter sums. A total whose sums are missing or non-finite is absent, so
 * a client shows "Unavailable" rather than a zero.
 */
export const listTotalLabels = (
  entity: keyof typeof entitySummary,
  sums: Readonly<Record<string, number>> | undefined,
): Record<string, string> | undefined => {
  if (!sums) return undefined;
  const labels: Record<string, string> = {};
  for (const total of entitySummary[entity].list.totals) {
    const label = listTotalLabel(total, sums);
    if (label !== null) labels[total.id] = label;
  }
  return labels;
};
