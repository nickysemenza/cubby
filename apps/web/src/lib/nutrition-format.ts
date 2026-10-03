import {
  buildNutrition,
  hasKnownEstimate,
  type MeasureEstimate,
  type NutritionEstimate,
  type MeasureEstimateCoverage,
} from "@cubby/schemas/nutrition";
import {
  TIER1_NUTRIENTS,
  type NutrientsPer100,
  type NutrientKey,
} from "@cubby/usda";

import { roundTo } from "~/lib/round-to";

/** One decimal place, dropping a trailing `.0` (`12.0` → `12`, `0.25` → `0.3`). */
export const trimAmount = (v: number) => roundTo(v, 1).toString();

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
    return estimate.status === "pending"
      ? "Pending"
      : estimate.reason === "not_applicable"
        ? "N/A"
        : "—";
  }

  const value =
    estimate.upper == null || estimate.upper === estimate.lower
      ? formatNumber(estimate.lower)
      : `${formatNumber(estimate.lower)}–${formatNumber(estimate.upper)}`;
  const confidence =
    estimate.status === "partial" ? `${value} known · partial` : value;
  return (estimate.coverage.inferredZero ?? 0) > 0
    ? `${confidence} · includes inferred zero`
    : confidence;
}

/** Accessible detail for an otherwise compact unavailable/pending cell. */
export function estimateStatusText(estimate: MeasureEstimate): string | null {
  if (hasKnownEstimate(estimate))
    return (estimate.coverage.inferredZero ?? 0) > 0
      ? `${estimate.coverage.inferredZero} evidence-backed inferred zero ${estimate.coverage.inferredZero === 1 ? "contribution" : "contributions"}`
      : null;
  if (estimate.status === "pending") return "Nutrition calculation pending";
  return estimate.reason === "not_applicable"
    ? "Nutrient marked not applicable"
    : estimate.reason === "yield_missing"
      ? "Unavailable: recipe yield is missing"
      : estimate.reason === "empty"
        ? "No nutrition contributors"
        : "Unavailable: no nutrition data";
}

/** Adapt a USDA/product record at the display boundary into the canonical shape. */
export const sourceNutritionEstimate = (
  nutrients: NutrientsPer100,
  inferredZeroNutrients: readonly NutrientKey[] = [],
): NutritionEstimate =>
  buildNutrition((key) => {
    const value = nutrients[TIER1_NUTRIENTS[key].code];
    if (value == null) return { status: "unavailable", reason: "no_data" };
    const coverage: MeasureEstimateCoverage = { covered: 1, total: 1 };
    if (inferredZeroNutrients.includes(key)) coverage.inferredZero = 1;
    return { status: "complete", lower: value, upper: null, coverage };
  });
