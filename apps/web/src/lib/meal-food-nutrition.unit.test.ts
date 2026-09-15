import { saveMealFoodInput } from "@cubby/schemas/meal";
import { buildNutrition } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  calculateFoodAmount,
  manualFoodTotals,
  productFoodTotals,
  productServingGrams,
} from "./meal-food-nutrition";
import { aggregateTotals } from "./nutrition-estimates";
import { makeProduct } from "./recipe-costing.fixtures";

describe("food logging amounts", () => {
  it("resolves a canonical serving from the current label before stored mappings", () => {
    const product = makeProduct("Example cereal", {
      labelNutrition: {
        servingGrams: 30,
        nutrients: { kcal: 120, protein: 4 },
        source: null,
      },
      mappings: [
        { a: { value: 1, unit: "serving" }, b: { value: 40, unit: "g" } },
      ],
      food: {
        fdc_id: 1,
        legacyFoodInfo: null,
        foodInfo: { data_type: "branded_food", description: "Example cereal" },
        nutritionInfo: {
          nutrientSummary: [],
          nutrientsPer100: { "208": 900 },
        },
        portionInfoRaw: [],
        brandedFoodInfo: {
          brand_owner: null,
          brand_name: null,
          branded_food_category: null,
          gtin_upc: null,
          ingredients: null,
          serving: {
            serving_size: 40,
            serving_size_unit: "g",
            household_serving_fulltext: "1 serving",
          },
        },
      },
    });
    const result = calculateFoodAmount(
      { value: 1.5, unit: "serving" },
      { kind: "product", product },
    );
    expect(result.grams).toBe(45);
    expect(result.weight).toMatchObject({ status: "complete", lower: 45 });
    expect(result.totals.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 180,
    });
  });

  it("uses live scaled servings for a recipe amount", () => {
    const result = calculateFoodAmount(
      { value: 2, unit: "servings" },
      {
        kind: "recipe",
        batch: {
          cost: {
            status: "complete",
            lower: 20,
            upper: null,
            coverage: { covered: 1, total: 1 },
          },
          nutrition: buildNutrition((key) =>
            key === "kcal"
              ? {
                  status: "complete",
                  lower: 2_000,
                  upper: null,
                  coverage: { covered: 1, total: 1 },
                }
              : { status: "unavailable", reason: "no_data" },
          ),
        },
        yieldBasis: {
          kind: "actual",
          lowerGrams: 800,
          upperGrams: null,
        },
        recipeYield: null,
        servings: 8,
        scale: 2,
      },
    );
    expect(result.batchShare).toMatchObject({
      status: "complete",
      lower: 0.125,
    });
    expect(result.grams).toBe(100);
    expect(result.totals.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 250,
    });
  });

  it("keeps entered grams exact while recipe yield uncertainty ranges totals", () => {
    const result = calculateFoodAmount(
      { value: 100, unit: "g" },
      {
        kind: "recipe",
        batch: {
          cost: { status: "unavailable", reason: "no_data" },
          nutrition: buildNutrition((key) =>
            key === "kcal"
              ? {
                  status: "complete",
                  lower: 1_000,
                  upper: null,
                  coverage: { covered: 1, total: 1 },
                }
              : { status: "unavailable", reason: "no_data" },
          ),
        },
        yieldBasis: {
          kind: "recipe",
          lowerGrams: 800,
          upperGrams: 1_000,
        },
        recipeYield: { value: 800, upperValue: 1_000, unit: "g" },
        servings: null,
        scale: 1,
      },
    );
    expect(result.grams).toBe(100);
    expect(result.weight).toMatchObject({
      status: "complete",
      lower: 100,
      upper: null,
    });
    expect(result.batchShare).toMatchObject({
      status: "complete",
      lower: 0.1,
      upper: 0.125,
    });
    expect(result.totals.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 100,
      upper: 125,
    });
  });

  it("returns unavailable estimates for an unknown source unit", () => {
    const result = calculateFoodAmount(
      { value: 1, unit: "mystery ladle" },
      {
        kind: "recipe",
        batch: {
          cost: { status: "unavailable", reason: "no_data" },
          nutrition: buildNutrition(() => ({
            status: "unavailable",
            reason: "no_data",
          })),
        },
        yieldBasis: {
          kind: "actual",
          lowerGrams: 800,
          upperGrams: null,
        },
        recipeYield: { value: 4, unit: "cup" },
        servings: null,
        scale: 1,
      },
    );
    expect(result.grams).toBeNull();
    expect(result.batchShare.status).toBe("unavailable");
    expect(result.totals.nutrition.kcal.status).toBe("unavailable");
  });

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
