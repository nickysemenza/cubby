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
import { wasmFormat } from "~/lib/wasm";

/** One decimal place, dropping a trailing `.0` (`12.0` → `12`, `0.25` → `0.3`). */
export const trimAmount = (v: number) => roundTo(v, 1).toString();

export type CompactEstimateUnit = "kcal" | "macro";
export type EstimateMeasure = "cost" | "kcal" | "macro" | "share";

/**
 * An estimate's long form for detail pages and labels: the figure or range,
 * `unit` once, then its confidence language (`420 kcal known · partial`,
 * `Pending`, `N/A`). Formatted by the Rust implementation native shares
 * (`golden-vectors/display-format.json`).
 */
export const formatEstimate = (
  estimate: MeasureEstimate,
  measure: EstimateMeasure,
  unit?: string,
): string => wasmFormat.format_estimate(estimate, measure, unit);

/** A bare calorie figure: whole, grouped (`1,234 kcal`). */
export const formatKcal = (value: number): string =>
  wasmFormat.format_kcal(value);

/**
 * The one-line macro cell: a range joins with an en dash, a partial estimate
 * ends in `+`, and anything unavailable or pending is `—`.
 */
export const compactEstimateText = (
  estimate: MeasureEstimate,
  unit: CompactEstimateUnit,
): string => wasmFormat.format_compact_estimate(estimate, unit);

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
