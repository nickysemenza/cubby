import type { MealRecipeOut } from "@cubby/schemas/meal";
import { describe, expect, it } from "vitest";
import { rollupMealTotals, scaleTotals } from "./helpers";

// Pure rollup math (no DB) — totals are linear in scale, so a meal's rollup is
// sum(recipe.totals × scale); a missing recipe total makes the rollup pending.
describe("rollupMealTotals / scaleTotals", () => {
  const totals = {
    costTotal: 10,
    caloriesTotal: 100,
    ingredientCount: 3,
    costCovered: 3,
    caloriesCovered: 3,
  };

  it("scales totals linearly and preserves upper bounds", () => {
    expect(scaleTotals(totals, 2)).toEqual({
      costTotal: 20,
      caloriesTotal: 200,
    });
    expect(scaleTotals({ ...totals, costTotalUpper: 12 }, 2)).toEqual({
      costTotal: 20,
      caloriesTotal: 200,
      costTotalUpper: 24,
    });
  });

  it("returns null when the recipe has no totals (never 0)", () => {
    expect(scaleTotals(null, 2)).toBeNull();
    expect(scaleTotals(undefined, 2)).toBeNull();
  });

  it("sums scaled totals and flags pending when any recipe is uncosted", () => {
    const recipes = [
      { scaledTotals: { costTotal: 10, caloriesTotal: 100 } },
      { scaledTotals: { costTotal: 20, caloriesTotal: 200 } },
    ] as MealRecipeOut[];
    expect(rollupMealTotals(recipes)).toEqual({
      costTotal: 30,
      caloriesTotal: 300,
      pending: false,
    });

    const withMissing = [...recipes, { scaledTotals: null }] as MealRecipeOut[];
    const rolled = rollupMealTotals(withMissing);
    expect(rolled.costTotal).toBe(30); // missing one contributes 0, not NaN
    expect(rolled.pending).toBe(true);
  });
});
