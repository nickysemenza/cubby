import { getMealPreparationsOut } from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { buildMealHeroStats } from "./meal-detail-page";

const mealSummary = {
  totals: {
    costTotal: 34.81,
    caloriesTotal: 2836,
    ingredientCount: 3,
    costCovered: 3,
    caloriesCovered: 3,
    pending: false,
  },
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
          cost: { status: "complete", lower: 10, upper: 10 },
          calories: { status: "complete", lower: 500, upper: 500 },
          protein: { status: "complete", lower: 50, upper: 50 },
        },
        projected: {
          portionCount: 1,
          cost: { status: "complete", lower: 10, upper: 10 },
          calories: { status: "complete", lower: 500, upper: 500 },
          protein: { status: "complete", lower: 50, upper: 50 },
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
      { label: "Calories", value: 2836 },
      { label: "Recipes", value: 5 },
    ]);
  });
});
