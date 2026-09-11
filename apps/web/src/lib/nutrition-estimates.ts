import type {
  WMeasureEstimate,
  WNamedEstimate,
  WNutritionTotals,
} from "@cubby/recipebridge";
import {
  buildNutrition,
  type MeasureEstimate,
  type NutritionEstimate,
  type NutritionTotals,
} from "@cubby/schemas/nutrition";
import { TIER1_NUTRIENT_KEYS, TIER1_NUTRIENTS } from "@cubby/usda-schemas";

import { wasm } from "~/lib/wasm";

export const fromWMeasureEstimate = (
  estimate: WMeasureEstimate,
): MeasureEstimate =>
  estimate.status === "complete" || estimate.status === "partial"
    ? { ...estimate, upper: estimate.upper ?? null }
    : estimate;

const toNamedEstimates = (nutrition: NutritionEstimate): WNamedEstimate[] =>
  TIER1_NUTRIENT_KEYS.map((key) => ({
    code: TIER1_NUTRIENTS[key].code,
    estimate: nutrition[key],
  }));

export const fromNamedEstimates = (
  entries: readonly WNamedEstimate[],
  missingReason: "no_data" | "empty" = "no_data",
): NutritionEstimate => {
  const byCode = new Map(
    entries.map((entry) => [entry.code, fromWMeasureEstimate(entry.estimate)]),
  );
  return buildNutrition(
    (key) =>
      byCode.get(TIER1_NUTRIENTS[key].code) ?? {
        status: "unavailable",
        reason: missingReason,
      },
  );
};

const toWTotals = (totals: NutritionTotals): WNutritionTotals => ({
  cost: totals.cost,
  nutrition: toNamedEstimates(totals.nutrition),
});

const fromWTotals = (
  totals: WNutritionTotals,
  missingReason: "no_data" | "empty" = "no_data",
): NutritionTotals => ({
  cost: fromWMeasureEstimate(totals.cost),
  nutrition: fromNamedEstimates(totals.nutrition, missingReason),
});

export const scaleEstimate = (
  estimate: MeasureEstimate,
  lowerFactor: number,
  upperFactor?: number,
): MeasureEstimate =>
  fromWMeasureEstimate(wasm.scale_estimate(estimate, lowerFactor, upperFactor));

export const scaleNutrition = (
  nutrition: NutritionEstimate,
  lowerFactor: number,
  upperFactor?: number,
): NutritionEstimate =>
  fromNamedEstimates(
    wasm.scale_nutrition_estimates(
      toNamedEstimates(nutrition),
      lowerFactor,
      upperFactor,
    ),
  );

export const scaleTotals = (
  totals: NutritionTotals,
  factor: number,
): NutritionTotals =>
  fromWTotals(wasm.scale_nutrition_totals(toWTotals(totals), factor));

export const aggregateEstimates = (
  entries: readonly MeasureEstimate[],
): MeasureEstimate =>
  fromWMeasureEstimate(wasm.aggregate_estimates([...entries]));

export const aggregateTotals = (
  entries: readonly NutritionTotals[],
): NutritionTotals =>
  fromWTotals(
    wasm.aggregate_nutrition_totals(entries.map(toWTotals)),
    entries.length === 0 ? "empty" : "no_data",
  );
