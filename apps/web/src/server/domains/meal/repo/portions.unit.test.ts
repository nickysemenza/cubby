import {
  buildNutrition,
  type MeasureEstimate,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import { describe, expect, it } from "vitest";

import { aggregateTotals } from "~/lib/nutrition-estimates";

import { batchTotalsFor, portionTotalsFor, yieldBasisFor } from "./portions";

const complete = (
  lower: number,
  upper: number | null = null,
): MeasureEstimate => ({
  status: "complete",
  lower,
  upper,
  coverage: { covered: 2, total: 2 },
});

const totals = (): NutritionTotals =>
  withMacros({
    cost: complete(10, 12),
    nutrition: buildNutrition((key) =>
      key === "kcal"
        ? complete(800, 960)
        : key === "protein"
          ? complete(80, 96)
          : { status: "unavailable", reason: "no_data" },
    ),
  });

describe("meal portion estimates", () => {
  it("prefers actual, then estimated, then current recipe yield", () => {
    const recipeYield = { value: 400, upperValue: 500, unit: "g" };
    expect(yieldBasisFor(525, 450, recipeYield, 2)).toEqual({
      kind: "actual",
      lowerGrams: 525,
      upperGrams: null,
    });
    expect(yieldBasisFor(null, 450, recipeYield, 2)).toEqual({
      kind: "estimated",
      lowerGrams: 450,
      upperGrams: null,
    });
    expect(yieldBasisFor(null, null, recipeYield, 2)).toEqual({
      kind: "recipe",
      lowerGrams: 800,
      upperGrams: 1000,
    });
  });

  it("scales every nutrient before applying a ranged recipe yield", () => {
    const basis = yieldBasisFor(
      null,
      null,
      { value: 400, upperValue: 500, unit: "g" },
      2,
    );
    const portion = portionTotalsFor(
      batchTotalsFor(totals(), new Date(), 2),
      basis,
      200,
    );

    expect(portion.cost).toMatchObject({
      status: "complete",
      lower: 4,
      upper: 6,
    });
    expect(portion.nutrition.protein).toMatchObject({
      status: "complete",
      lower: 32,
      upper: 48,
    });
    expect(portion.nutrition.calcium).toEqual({
      status: "unavailable",
      reason: "no_data",
    });
  });

  it("keeps missing and stale recipe totals explicit", () => {
    expect(batchTotalsFor(null, null, 1).cost).toEqual({
      status: "pending",
      reason: "totals_missing",
    });
    expect(batchTotalsFor(totals(), null, 1).nutrition.protein).toEqual({
      status: "pending",
      reason: "totals_stale",
    });
  });

  it("keeps a known subtotal when another portion is pending", () => {
    const known = totals();
    const pending = batchTotalsFor(null, null, 1);
    const aggregate = aggregateTotals([known, pending]);

    expect(aggregate.cost).toMatchObject({
      status: "partial",
      lower: 10,
      upper: 12,
    });
    expect(aggregate.nutrition.kcal).toMatchObject({
      status: "partial",
      lower: 800,
      upper: 960,
    });
  });
});
