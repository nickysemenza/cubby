import {
  buildNutrition,
  type MeasureEstimate,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda-schemas";
import { describe, expect, it } from "vitest";

import {
  aggregateEstimates,
  aggregateTotals,
  scaleEstimate,
  scaleNutrition,
  scaleTotals,
} from "~/lib/nutrition-estimates";

const complete = (
  lower: number,
  upper: number | null = null,
): MeasureEstimate => ({
  status: "complete",
  lower,
  upper,
  coverage: { covered: 1, total: 1 },
});

const totals = (value: number): NutritionTotals =>
  withMacros({
    cost: complete(value),
    nutrition: buildNutrition(() => complete(value)),
  });

describe("nutrition estimate arithmetic", () => {
  it("scales point and ranged estimates through WASM", () => {
    expect(scaleEstimate(complete(10, 12), 2, 3)).toEqual({
      status: "complete",
      lower: 20,
      upper: 36,
      coverage: { covered: 1, total: 1 },
    });
    expect(scaleNutrition(totals(4).nutrition, 0.5).protein).toEqual(
      complete(2),
    );
    expect(scaleTotals(totals(4), 3).cost).toEqual(complete(12));
  });

  it("aggregates known values while disclosing incomplete contributors", () => {
    expect(
      aggregateEstimates([
        complete(4),
        { status: "pending", reason: "totals_stale" },
        { status: "unavailable", reason: "no_data" },
      ]),
    ).toEqual({
      status: "partial",
      lower: 4,
      upper: null,
      coverage: { covered: 1, total: 3 },
    });
  });

  it("keeps a pending-only aggregate pending", () => {
    expect(
      aggregateEstimates([
        { status: "pending", reason: "totals_stale" },
        { status: "unavailable", reason: "no_data" },
      ]),
    ).toEqual({ status: "pending", reason: "totals_stale" });
  });

  it("reports zero coverage when every contributor is unavailable", () => {
    expect(
      aggregateEstimates([
        { status: "unavailable", reason: "no_data" },
        { status: "unavailable", reason: "no_data" },
      ]),
    ).toEqual({
      status: "unavailable",
      reason: "no_data",
      coverage: { covered: 0, total: 2 },
    });
    // No contributors at all: `empty`, and no coverage key to count.
    expect(aggregateEstimates([])).toEqual({
      status: "unavailable",
      reason: "empty",
    });
  });

  it("returns complete catalog-shaped empty totals", () => {
    const aggregate = aggregateTotals([]);
    expect(aggregate.cost).toEqual({ status: "unavailable", reason: "empty" });
    expect(Object.keys(aggregate.nutrition).sort()).toEqual(
      [...TIER1_NUTRIENT_KEYS].sort(),
    );
    expect(aggregate.nutrition.protein).toEqual({
      status: "unavailable",
      reason: "empty",
    });
  });

  it("aggregates totals nutrient by nutrient", () => {
    const aggregate = aggregateTotals([totals(2), totals(3)]);
    expect(aggregate.cost).toEqual({
      status: "complete",
      lower: 5,
      upper: null,
      coverage: { covered: 2, total: 2 },
    });
    expect(aggregate.nutrition.kcal).toEqual(aggregate.cost);
  });
});
