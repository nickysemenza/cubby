import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import { describe, expect, it } from "vitest";

import {
  aggregateMealPreparationEstimates,
  batchEstimateFor,
  portionEstimateFor,
  yieldBasisFor,
} from "./portions";

const recipeTotals = (overrides: Partial<RecipeTotals> = {}): RecipeTotals => ({
  costTotal: 10,
  caloriesTotal: 800,
  proteinTotal: 80,
  ingredientCount: 2,
  costCovered: 2,
  caloriesCovered: 2,
  proteinCovered: 2,
  ...overrides,
});

describe("meal portion estimates", () => {
  it("scales every measure before applying a ranged recipe yield", () => {
    const totals = recipeTotals({
      costTotalUpper: 12,
      caloriesTotalUpper: 960,
      proteinTotalUpper: 96,
    });
    const basis = yieldBasisFor(
      null,
      null,
      { value: 400, upperValue: 500, unit: "g" },
      2,
    );

    expect(
      portionEstimateFor(
        batchEstimateFor(totals, new Date(), 2, "cost"),
        basis,
        200,
      ),
    ).toEqual({
      status: "complete",
      lower: 4,
      upper: 6,
    });
    expect(
      portionEstimateFor(
        batchEstimateFor(totals, new Date(), 2, "protein"),
        basis,
        200,
      ),
    ).toEqual({ status: "complete", lower: 32, upper: 48 });
  });

  it("keeps missing coverage explicit rather than treating it as zero", () => {
    expect(
      batchEstimateFor(
        recipeTotals({ proteinCovered: 1 }),
        new Date(),
        1,
        "protein",
      ),
    ).toEqual({ status: "partial", lower: 80 });
    expect(
      batchEstimateFor(recipeTotals({ costCovered: 0 }), new Date(), 1, "cost"),
    ).toEqual({ status: "unavailable", reason: "cost_uncovered" });
    expect(
      batchEstimateFor(
        recipeTotals({ proteinCovered: undefined }),
        new Date(),
        1,
        "protein",
      ),
    ).toEqual({ status: "pending", reason: "totals_stale" });
  });

  it("aggregates confirmed and projected portions without losing known partial values", () => {
    expect(
      aggregateMealPreparationEstimates([
        { status: "complete", lower: 10, upper: null },
        { status: "unavailable", reason: "protein_uncovered" },
        { status: "partial", lower: 5 },
      ]),
    ).toEqual({ status: "partial", lower: 15 });
  });
});
