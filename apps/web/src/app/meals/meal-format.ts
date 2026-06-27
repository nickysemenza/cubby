import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type { MealTotals } from "@cubby/schemas/meal";
import { formatCurrency } from "~/lib/utils";

/** Round a need/have amount for display without trailing float noise. */
export const formatAmount = (value: number, unit: string | null): string => {
  const rounded = Math.round(value * 100) / 100;
  return unit ? `${rounded} ${unit}` : `${rounded}`;
};

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
    default:
      return status;
  }
};
