import { getMealPreparationsOut } from "@cubby/schemas/meal";
import { buildNutrition } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { buildMealHeroStats } from "./meal-detail-page";

const complete = (lower: number) => ({
  status: "complete" as const,
  lower,
  upper: lower,
  coverage: { covered: 1, total: 1 },
});
const nutritionTotals = (cost: number, kcal: number, protein: number) => ({
  cost: complete(cost),
  nutrition: buildNutrition((key) =>
    key === "kcal"
      ? complete(kcal)
      : key === "protein"
        ? complete(protein)
        : { status: "unavailable", reason: "no_data" },
  ),
});
const mealSummary = {
  totals: nutritionTotals(34.81, 2836, 200),
  recipes: [{}, {}, {}, {}, {}],
} as const;

describe("buildMealHeroStats", () => {
  it("prioritizes confirmed consumption across cost, calories, and protein", () => {
    const preparation = getMealPreparationsOut.parse({
      mealId: testShortcode("meal", "hero-stats"),
      preparations: [],
      totals: {
        confirmed: {
          portionCount: 1,
          totals: nutritionTotals(10, 500, 50),
        },
        projected: {
          portionCount: 1,
          totals: nutritionTotals(10, 500, 50),
        },
      },
    });

    expect(buildMealHeroStats(mealSummary, preparation)).toEqual([
      { label: "Consumed cost", value: "$10.00" },
      { label: "Consumed calories", value: "500 kcal" },
      { label: "Consumed protein", value: "50 g" },
      { label: "Recipes", value: 5 },
    ]);
  });

  it("keeps the batch hero when nothing has been confirmed", () => {
    expect(buildMealHeroStats(mealSummary, undefined)).toEqual([
      { label: "Cost", value: "$34.81" },
      { label: "Calories", value: "2,836 kcal" },
      { label: "Recipes", value: 5 },
    ]);
  });
});
