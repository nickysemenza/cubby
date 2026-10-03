import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { LocationValuation } from "@cubby/schemas/location";
import type {
  MeasureEstimate,
  NutritionTotals,
} from "@cubby/schemas/nutrition";
import type { ProductQuantityLedgerOut } from "@cubby/schemas/product";
import type { PurchaseReconciliation } from "@cubby/schemas/purchase";
import type { RecipeTimes } from "@cubby/schemas/recipe";

import { formatCurrency } from "~/lib/number-format";
import { formatEstimate } from "~/lib/nutrition-format";
import type { PerUnitPrices } from "~/lib/price-mapping-utils";
import { formatRecipeTime } from "~/lib/recipe-time";
import { formatUnitPrice } from "~/lib/unit-price-format";

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

const formatKcal = (value: number) => `${Math.round(value)} kcal`;

/** A recipe or meal total, with its range and confidence language intact. */
export const estimateLabel = (
  estimate: MeasureEstimate,
  metric: "cost" | "kcal",
): string =>
  formatEstimate(
    estimate,
    metric === "cost" ? (value) => formatCurrency(value) : formatKcal,
  );

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
  prices?.natural
    ? `${formatUnitPrice(prices.natural.price)}/${prices.natural.unit}`
    : null;

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
