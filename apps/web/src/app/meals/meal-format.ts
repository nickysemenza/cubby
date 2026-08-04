import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type { MealTotals } from "@cubby/schemas/meal";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { formatCurrency } from "~/lib/utils";

/**
 * Format a shopping-list need/have/shortfall amount, via the same WASM
 * formatter every other amount surface uses (`tryFormatAmount`) — this used
 * to hand-round with `Math.round(value * 100) / 100` and string-concat the
 * unit, which bypassed the engine's range/"each" handling and rendered by a
 * different rule than the rest of the app.
 *
 * `basisUnit` is `null` (or, per `availability.rs`'s "needs nothing" group,
 * `""`) when there's no unit to report; WASM's own bare-count sentinel unit
 * ("whole") renders the value with no unit suffix (see
 * format-amount.unit.test.ts's "bare-count" cases), so falling back to it
 * here reuses that behavior instead of re-deriving it.
 */
export const formatAmount = (value: number, unit: string | null): string =>
  tryFormatAmount({ value, unit: unit || "whole" });

/** Meal/day cost rollup as a short string; "—" when no recipe has totals. */
export const formatMealCost = (totals: MealTotals): string => {
  if (totals.pending && totals.costTotal === 0) return "—";
  const base = formatCurrency(totals.costTotal);
  return totals.pending ? `${base}+` : base;
};

/** Text-color class per availability status (warm semantic tokens). */
export const statusClass = (status: IngredientAvailabilityStatus): string => {
  switch (status) {
    case "ok":
      return "text-positive";
    case "short":
      return "text-warning";
    case "missing":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
};

export const statusLabel = (status: IngredientAvailabilityStatus): string => {
  switch (status) {
    case "ok":
      return "Have enough";
    case "short":
      return "Short";
    case "missing":
      return "Need to buy";
    case "unconvertible":
      return "Can't compare units";
    case "subrecipe":
      return "Sub-recipe";
    default:
      return status;
  }
};
