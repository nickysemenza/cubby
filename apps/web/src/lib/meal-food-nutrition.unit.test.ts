import { saveMealFoodInput } from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  manualFoodTotals,
  productFoodTotals,
  productServingGrams,
} from "./meal-food-nutrition";
import { aggregateTotals } from "./nutrition-estimates";
import { makeProduct } from "./recipe-costing.fixtures";

describe("food logging amounts", () => {
  it("uses package weight despite conflicting serving mappings and supports fractions", () => {
    const product = makeProduct("Example cereal", {
      labelNutrition: {
        servingGrams: 30,
        nutrients: { kcal: 120, protein: 4, fat: 0 },
        source: null,
      },
      mappings: [
        { a: { value: 1, unit: "serving" }, b: { value: 40, unit: "g" } },
      ],
      nutrientsPer100: { "208": 900, "205": 80 },
    });
    expect(productServingGrams(product)).toBe(30);
    const totals = productFoodTotals(
      product,
      1.5 * productServingGrams(product)!,
    );
    expect(totals.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 180,
    });
    expect(totals.nutrition.protein).toMatchObject({
      status: "complete",
      lower: 6,
    });
    expect(totals.nutrition.fat).toMatchObject({
      status: "complete",
      lower: 0,
    });
    expect(totals.nutrition.carbs.status).toBe("unavailable");
  });
  it("does not equate one package with one serving", () => {
    const product = makeProduct("Example bag", {
      mappings: [
        { a: { value: 1, unit: "each" }, b: { value: 300, unit: "g" } },
      ],
    });
    expect(productServingGrams(product)).toBeNull();
  });
  it("uses available serving mappings without a package label", () => {
    const product = makeProduct("Example food", {
      mappings: [
        { a: { value: 1, unit: "serving" }, b: { value: 25, unit: "g" } },
      ],
      nutrientsPer100: { "208": 400, "203": 10 },
    });
    expect(productServingGrams(product)).toBe(25);
    expect(productFoodTotals(product, 12.5).nutrition.protein).toMatchObject({
      status: "complete",
      lower: 1.25,
    });
  });
  it("keeps missing contributions partial and explicit zero complete", () => {
    const total = aggregateTotals([
      manualFoodTotals({ kcal: 100, fat: 0 }),
      manualFoodTotals({ kcal: 50, protein: 4, fat: 0 }),
    ]);
    expect(total.nutrition.protein).toMatchObject({
      status: "partial",
      lower: 4,
    });
    expect(total.nutrition.fat).toMatchObject({ status: "complete", lower: 0 });
    expect(total.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 150,
    });
  });
  it("requires a name and a nutrient while allowing weightless manual entries", () => {
    const common = {
      mealId: testShortcode("meal", "MEL-TEST"),
      ledgerPartyId: testShortcode("ledgerParty", "LPY-TEST"),
      sourceKind: "manual",
      grams: null,
    };
    expect(
      saveMealFoodInput.safeParse({
        ...common,
        name: " ",
        nutrients: { kcal: 0 },
      }).success,
    ).toBe(false);
    expect(
      saveMealFoodInput.safeParse({ ...common, name: "Snack", nutrients: {} })
        .success,
    ).toBe(false);
    expect(
      saveMealFoodInput.safeParse({
        ...common,
        name: "Snack",
        nutrients: { kcal: 0 },
      }).success,
    ).toBe(true);
  });
});
