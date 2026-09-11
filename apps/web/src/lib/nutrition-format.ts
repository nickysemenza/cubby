import {
  buildNutrition,
  hasKnownEstimate,
  type MeasureEstimate,
  type NutritionEstimate,
} from "@cubby/schemas/nutrition";
import { TIER1_NUTRIENTS, type NutrientsPer100 } from "@cubby/usda-schemas";

/**
 * Render an estimate without hiding its confidence. Callers own the unit and
 * rounding convention through `formatNumber`; this helper owns the shared
 * partial/range vocabulary.
 */
export function formatEstimate(
  estimate: MeasureEstimate,
  formatNumber: (value: number) => string,
): string {
  if (!hasKnownEstimate(estimate)) {
    return estimate.status === "pending" ? "Pending" : "—";
  }

  const value =
    estimate.upper == null || estimate.upper === estimate.lower
      ? formatNumber(estimate.lower)
      : `${formatNumber(estimate.lower)}–${formatNumber(estimate.upper)}`;
  return estimate.status === "partial" ? `${value} known · partial` : value;
}

/** Accessible detail for an otherwise compact unavailable/pending cell. */
export function estimateStatusText(estimate: MeasureEstimate): string | null {
  if (hasKnownEstimate(estimate)) return null;
  if (estimate.status === "pending") return "Nutrition calculation pending";
  return estimate.reason === "yield_missing"
    ? "Unavailable: recipe yield is missing"
    : estimate.reason === "empty"
      ? "No nutrition contributors"
      : "Unavailable: no nutrition data";
}

/** Adapt a USDA/product record at the display boundary into the canonical shape. */
export const sourceNutritionEstimate = (
  nutrients: NutrientsPer100,
): NutritionEstimate =>
  buildNutrition((key) => {
    const value = nutrients[TIER1_NUTRIENTS[key].code];
    return value == null
      ? { status: "unavailable", reason: "no_data" }
      : {
          status: "complete",
          lower: value,
          upper: null,
          coverage: { covered: 1, total: 1 },
        };
  });
