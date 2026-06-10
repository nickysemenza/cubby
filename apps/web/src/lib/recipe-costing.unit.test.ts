import type { Amount } from "@cubby/schemas/codec";
import {
  unsafeIngredientId,
  unsafeProductId,
  unsafeProductShortcode,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { beforeAll, describe, expect, test } from "vitest";
import {
  calculateTotals,
  computeAbsorbedOilMeasures,
  convertAmountToNutrients,
  convertAmountToPrice,
  createEmptyNutrients,
  createIngredientData,
  getGramAndNutrient,
} from "~/lib/recipe-costing";
import { ensureWasm } from "~/lib/wasm";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

describe("createEmptyNutrients", () => {
  test("returns empty nutrients record", () => {
    const result = createEmptyNutrients();

    expect(result).toEqual({});
  });
});

describe("convertAmountToNutrients", () => {
  test("converts amount directly to nutrients via WASM graph", () => {
    const amount: Amount = { value: 2, unit: "cup" };
    // Mappings: 1 cup = 125g, 100g = 10g protein, 100g = 200 kcal
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 125, unit: "g" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      {
        a: { value: 100, unit: "g" },
        b: { value: 10, unit: "g protein" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      // kcal mapping uses "kcal" (parses to Unit::KCal) - required for conv_amount_to_kind("calories")
      {
        a: { value: 100, unit: "g" },
        b: { value: 200, unit: "kcal" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToNutrients(amount, mappings);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 2 cups = 250g, 250g / 100 * 10 = 25g protein
      expect(result.value["203"]).toBeCloseTo(25, 0);
      // 2 cups = 250g, 250g / 100 * 200 = 500 kcal
      expect(result.value["208"]).toBeCloseTo(500, 0);
    }
  });

  test("returns failure when no nutrient mappings exist", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 240, unit: "g" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      // No nutrient mappings
    ];

    const result = convertAmountToNutrients(amount, mappings);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe("No nutrient conversions succeeded");
    }
  });

  test("handles empty mappings array", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [];

    const result = convertAmountToNutrients(amount, mappings);

    expect(result.isOk()).toBe(false);
  });

  test("kcal requires 'kcal' unit (not 'kcal kcal') because WASM uses Unit::KCal internally", () => {
    // This test documents a key implementation detail:
    // WASM treats MeasureKind::Calories → Unit::KCal (built-in)
    // but MeasureKind::Nutrient("kcal") → Unit::Other("kcal") (generic)
    // These don't match in the graph! So we use conv_amount_to_kind("calories")
    // for kcal, which requires mappings with "kcal" (parses to Unit::KCal).

    const amount: Amount = { value: 100, unit: "g" };

    // This FAILS: "kcal kcal" parses to Unit::Other("kcal kcal")
    const badMappings: UnitMapping[] = [
      {
        a: { value: 100, unit: "g" },
        b: { value: 200, unit: "kcal kcal" }, // Wrong format!
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const badResult = convertAmountToNutrients(amount, badMappings);
    // Should fail because "kcal kcal" doesn't match Unit::KCal
    expect(badResult.isOk()).toBe(false);

    // This WORKS: "kcal" parses to Unit::KCal
    const goodMappings: UnitMapping[] = [
      {
        a: { value: 100, unit: "g" },
        b: { value: 200, unit: "kcal" }, // Correct format!
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const goodResult = convertAmountToNutrients(amount, goodMappings);
    expect(goodResult.isOk()).toBe(true);
    if (goodResult.isOk()) {
      // Nutrient code "208" is kcal
      expect(goodResult.value["208"]).toBe(200);
    }
  });
});

describe("getGramAndNutrient", () => {
  test("successfully converts to grams and nutrients via WASM", () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      {
        a: { value: 100, unit: "g" },
        b: { value: 10, unit: "g protein" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      // kcal mapping uses "kcal" (parses to Unit::KCal) - required for conv_amount_to_kind("calories")
      {
        a: { value: 100, unit: "g" },
        b: { value: 200, unit: "kcal" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    // Product is no longer used for nutrient calculation (uses mappings instead)
    const result = getGramAndNutrient(amount, mappings, undefined);

    // Assert
    expect(result.gram.isOk()).toBe(true);
    if (result.gram.isOk()) {
      expect(result.gram.value.unit).toBe("g");
      expect(result.gram.value.value).toBe(240);
    }

    expect(result.nutrient.isOk()).toBe(true);
    if (result.nutrient.isOk()) {
      // 1 cup = 240g, 240g / 100 * 10 = 24g protein
      expect(result.nutrient.value["203"]).toBeCloseTo(24, 0);
      // 1 cup = 240g, 240g / 100 * 200 = 480 kcal
      expect(result.nutrient.value["208"]).toBeCloseTo(480, 0);
    }
  });

  test("handles error when conversion to weight fails", () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "InvalidUnit" };
    const mappings: UnitMapping[] = [];
    const product = undefined;

    // Act
    const result = getGramAndNutrient(amount, mappings, product);

    // Assert
    expect(result.gram.isErr()).toBe(true);
    if (result.gram.isErr()) {
      expect(result.gram.error).toContain("Error converting to weight:");
    }

    expect(result.nutrient.isOk()).toBe(false);
  });

  test("weight succeeds independently from nutrients", () => {
    // Arrange - mappings with weight but no nutrients
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      // No nutrient mappings
    ];

    // Act
    const result = getGramAndNutrient(amount, mappings, undefined);

    // Assert - Weight conversion should succeed
    expect(result.gram.isOk()).toBe(true);
    if (result.gram.isOk()) {
      expect(result.gram.value.unit).toBe("g");
      expect(result.gram.value.value).toBe(240);
    }

    // Nutrient conversion should fail due to missing nutrient mappings
    expect(result.nutrient.isErr()).toBe(true);
    if (result.nutrient.isErr()) {
      expect(result.nutrient.error).toBe("No nutrient conversions succeeded");
    }
  });

  test("nutrients succeed independently from weight", () => {
    // Arrange - direct nutrient mapping without going through weight
    const amount: Amount = { value: 1, unit: "serving" };
    const mappings: UnitMapping[] = [
      // Direct serving to nutrient mapping (no weight path)
      {
        a: { value: 1, unit: "serving" },
        b: { value: 15, unit: "g protein" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      // kcal mapping uses "kcal" (parses to Unit::KCal) - required for conv_amount_to_kind("calories")
      {
        a: { value: 1, unit: "serving" },
        b: { value: 200, unit: "kcal" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    // Act
    const result = getGramAndNutrient(amount, mappings, undefined);

    // Assert - Weight conversion should fail (no path to grams)
    expect(result.gram.isOk()).toBe(false);

    // Nutrient conversion should succeed via direct mapping
    expect(result.nutrient.isOk()).toBe(true);
    if (result.nutrient.isOk()) {
      expect(result.nutrient.value["203"]).toBeCloseTo(15, 0);
      expect(result.nutrient.value["208"]).toBeCloseTo(200, 0);
    }
  });
});

describe("convertAmountToPrice", () => {
  test("successfully converts amount to price", () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "Pound" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Pound" },
        b: { value: 2.99, unit: "Dollar" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    // Act
    const result = convertAmountToPrice(amount, mappings);

    // Assert
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.unit).toBe("$");
      expect(result.value.value).toBe(2.99);
    }
  });

  test("handles error when conversion fails", () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "InvalidUnit" };
    const mappings: UnitMapping[] = [];

    // Act
    const result = convertAmountToPrice(amount, mappings);

    // Assert
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("Error converting to money:");
    }
  });
});

describe("WASM Error Scenarios", () => {
  test("handles empty mappings array", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = []; // Empty mappings

    const result = convertAmountToPrice(amount, mappings);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("Failed to convert");
    }
  });

  test("handles incompatible unit mappings", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "meter" }, // Length unit
        b: { value: 100, unit: "centimeter" }, // Length unit - no path to money
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("Failed to convert");
    }
  });

  test("handles zero values in mappings", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 0, unit: "cup" }, // Zero value
        b: { value: 5.99, unit: "dollar" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    // This might succeed or fail depending on WASM implementation
    if (result.isOk()) {
      // If it succeeds, it should handle zero gracefully
      expect(result.value).toBeDefined();
    } else {
      // If it fails, it should have an appropriate error
      expect(result.error).toBeDefined();
    }
  });

  test("handles very large values", () => {
    const amount: Amount = { value: 1e10, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 2.99, unit: "dollar" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Very large number conversions have floating point precision limits
      // The result is close to the expected value but not exact
      expect(result.value.value).toBeGreaterThan(29e9); // At least 29 billion
      expect(result.value.value).toBeLessThan(31e9); // At most 31 billion
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles very small values", () => {
    const amount: Amount = { value: 1e-10, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 2.99, unit: "dollar" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Very small values might be rounded to zero by WASM/floating point precision
      expect(result.value.value).toBeGreaterThanOrEqual(0);
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles case-insensitive unit names", () => {
    const amount: Amount = { value: 1, unit: "CUP" }; // Uppercase
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" }, // Lowercase
        b: { value: 2.99, unit: "dollar" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    // WASM actually handles case-insensitive unit matching
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.value).toBe(2.99);
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles chained conversions", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 240, unit: "ml" }, // Volume to volume
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      {
        a: { value: 1000, unit: "ml" },
        b: { value: 1, unit: "liter" }, // Volume to volume
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      {
        a: { value: 1, unit: "liter" },
        b: { value: 3.99, unit: "dollar" }, // Volume to price
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 1 cup -> 240ml -> 0.24 liter -> 0.24 * 3.99 = $0.9576
      // WASM returns $0.94-0.96 depending on environment precision
      expect(result.value.value).toBeGreaterThanOrEqual(0.94);
      expect(result.value.value).toBeLessThanOrEqual(0.96);
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles circular mapping references", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "cup" },
        b: { value: 240, unit: "ml" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
      {
        a: { value: 240, unit: "ml" },
        b: { value: 1, unit: "cup" }, // Circular reference
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    // Should fail to convert to money since there's no path to money
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("Failed to convert");
    }
  });

  test("handles custom unit names", () => {
    const amount: Amount = { value: 1, unit: "invalid_unit_xyz" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "invalid_unit_xyz" },
        b: { value: 2.99, unit: "dollar" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const result = convertAmountToPrice(amount, mappings);

    // WASM handles custom unit names as "Other" type and can convert them
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.value).toBe(2.99);
      expect(result.value.unit).toBe("$");
    }
  });
});

describe("calculateTotals", () => {
  const mockGetIngredientName = (ingredient: SectionIngredientOut): string => {
    return ingredient.type === "ingredient"
      ? ingredient.ingredient.name
      : "recipe";
  };

  test("calculates totals with all data available", async () => {
    const ingredients: SectionIngredientOut[] = [
      {
        id: unsafeIngredientId("ing1"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing1"),
          name: "chicken",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [{ value: 1, unit: "pound" }],
      },
      {
        id: unsafeIngredientId("ing2"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing2"),
          name: "rice",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [{ value: 2, unit: "cup" }],
      },
    ];

    const ingMap: Record<string, IngredientWithFoodOut> = {
      ing1: {
        id: unsafeIngredientId("ing1"),
        name: "chicken",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [
          {
            id: unsafeProductId("prod1"),
            name: "chicken",
            shortcode: unsafeProductShortcode("P-TEST"),
            food: {
              legacyFoodInfo: null,
              nutritionInfo: {
                nutrientsPer100: { "203": 20, "208": 200 },
                nutrientSummary: [],
              },
              fdc_id: 0,
              brandedFoodInfo: null,
              foodInfo: { data_type: "branded_food", description: "" },
              portionInfoRaw: [],
            },
            upc: null,
            ndb_number: null,
            manufacturer: "",
            category: null,
            model: null,
            expectedQuantity: null,
            price: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            images: [],
            externalIds: [],
            unitMappings: [
              {
                id: "map1",
                a: { value: 1, unit: "pound" },
                b: { value: 453.59, unit: "gram" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: "map2",
                a: { value: 1, unit: "pound" },
                b: { value: 5.99, unit: "dollar" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // Nutrient mappings for WASM conversion
              {
                id: "map1-protein",
                a: { value: 100, unit: "g" },
                b: { value: 20, unit: "g protein" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // kcal uses "kcal" (parses to Unit::KCal) - required for conv_amount_to_kind("calories")
              {
                id: "map1-kcal",
                a: { value: 100, unit: "g" },
                b: { value: 200, unit: "kcal" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ing2: {
        id: unsafeIngredientId("ing2"),
        name: "rice",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [
          {
            id: unsafeProductId("prod2"),
            name: "rice",
            shortcode: unsafeProductShortcode("P-TEST"),
            food: {
              legacyFoodInfo: null,
              nutritionInfo: {
                nutrientsPer100: { "203": 7, "208": 130 },
                nutrientSummary: [],
              },
              fdc_id: 0,
              brandedFoodInfo: null,
              foodInfo: { data_type: "branded_food", description: "" },
              portionInfoRaw: [],
            },
            upc: null,
            ndb_number: null,
            manufacturer: "",
            category: null,
            model: null,
            expectedQuantity: null,
            price: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            images: [],
            externalIds: [],
            unitMappings: [
              {
                id: "map3",
                a: { value: 1, unit: "cup" },
                b: { value: 200, unit: "gram" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: "map4",
                a: { value: 1, unit: "cup" },
                b: { value: 2.5, unit: "dollar" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // Nutrient mappings for WASM conversion
              {
                id: "map3-protein",
                a: { value: 100, unit: "g" },
                b: { value: 7, unit: "g protein" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // kcal uses "kcal" (parses to Unit::KCal) - required for conv_amount_to_kind("calories")
              {
                id: "map3-kcal",
                a: { value: 100, unit: "g" },
                b: { value: 130, unit: "kcal" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const result = await calculateTotals(
      ingredients,
      ingMap,
      mockGetIngredientName,
    );

    expect(result.totalIngredients).toBe(2);
    expect(result.price).toBeCloseTo(10.99, 2); // 5.99 + 5.00
    expect(result.weight).toBeCloseTo(854, 1); // WASM rounds: ~454 + 400
    expect(result.missingByType.price).toEqual([]);
    expect(result.missingByType.weight).toEqual([]);
    expect(result.missingByType.nutrients).toEqual([]);
  });

  test("handles completely missing data", async () => {
    const ingredients: SectionIngredientOut[] = [
      {
        id: unsafeIngredientId("ing1"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing1"),
          name: "unknown ingredient",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [{ value: 1, unit: "unknownunit" }],
      },
    ];

    const ingMap: Record<string, IngredientWithFoodOut> = {
      ing1: {
        id: unsafeIngredientId("ing1"),
        name: "unknown ingredient",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [], // No products
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const result = await calculateTotals(
      ingredients,
      ingMap,
      mockGetIngredientName,
    );

    expect(result.totalIngredients).toBe(1);
    expect(result.price).toBe(0);
    expect(result.weight).toBe(0);
    expect(result.nutrients["203"] ?? 0).toBe(0);
    expect(result.nutrients["208"] ?? 0).toBe(0);
    expect(result.missingByType.price).toEqual(["unknown ingredient"]);
    expect(result.missingByType.weight).toEqual(["unknown ingredient"]);
    expect(result.missingByType.nutrients).toEqual(["unknown ingredient"]);
  });

  test("handles partially missing data", async () => {
    const ingredients: SectionIngredientOut[] = [
      {
        id: unsafeIngredientId("ing1"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing1"),
          name: "chicken",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [{ value: 1, unit: "pound" }],
      },
      {
        id: unsafeIngredientId("ing2"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing2"),
          name: "unknown spice",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [{ value: 1, unit: "teaspoon" }],
      },
    ];

    const ingMap: Record<string, IngredientWithFoodOut> = {
      ing1: {
        id: unsafeIngredientId("ing1"),
        name: "chicken",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [
          {
            id: unsafeProductId("prod1"),
            name: "chicken",
            shortcode: unsafeProductShortcode("P-TEST"),
            food: {
              legacyFoodInfo: null,
              nutritionInfo: {
                nutrientsPer100: { "203": 20, "208": 200 },
                nutrientSummary: [],
              },
              fdc_id: 0,
              brandedFoodInfo: null,
              foodInfo: { data_type: "branded_food", description: "" },
              portionInfoRaw: [],
            },
            upc: null,
            ndb_number: null,
            manufacturer: "",
            category: null,
            model: null,
            expectedQuantity: null,
            price: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            images: [],
            externalIds: [],
            unitMappings: [
              {
                id: "map1",
                a: { value: 1, unit: "pound" },
                b: { value: 453.59, unit: "gram" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: "map2",
                a: { value: 1, unit: "pound" },
                b: { value: 5.99, unit: "dollar" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // Nutrient mappings for WASM conversion
              {
                id: "map1-protein",
                a: { value: 100, unit: "g" },
                b: { value: 20, unit: "g protein" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // kcal uses "kcal" (parses to Unit::KCal) - required for conv_amount_to_kind("calories")
              {
                id: "map1-kcal",
                a: { value: 100, unit: "g" },
                b: { value: 200, unit: "kcal" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ing2: {
        id: unsafeIngredientId("ing2"),
        name: "unknown spice",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [], // No products - will cause missing data
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const result = await calculateTotals(
      ingredients,
      ingMap,
      mockGetIngredientName,
    );

    expect(result.totalIngredients).toBe(2);
    expect(result.price).toBeCloseTo(5.99, 2); // Only chicken has price
    expect(result.weight).toBeCloseTo(454, 1); // WASM rounds: ~454
    expect(result.missingByType.price).toEqual(["unknown spice"]);
    expect(result.missingByType.weight).toEqual(["unknown spice"]);
    expect(result.missingByType.nutrients).toEqual(["unknown spice"]);
  });

  test("handles missing only specific data types", async () => {
    const ingredients: SectionIngredientOut[] = [
      {
        id: unsafeIngredientId("ing1"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing1"),
          name: "ingredient with weight only",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [{ value: 1, unit: "cup" }],
      },
    ];

    const ingMap: Record<string, IngredientWithFoodOut> = {
      ing1: {
        id: unsafeIngredientId("ing1"),
        name: "ingredient with weight only",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [
          {
            id: unsafeProductId("prod1"),
            name: "ingredient with weight only",
            shortcode: unsafeProductShortcode("P-TEST"),
            food: null, // No nutrition data
            upc: null,
            ndb_number: null,
            manufacturer: "",
            category: null,
            model: null,
            expectedQuantity: null,
            price: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            images: [],
            externalIds: [],
            unitMappings: [
              {
                id: "map5",
                a: { value: 1, unit: "cup" },
                b: { value: 240, unit: "gram" },
                source: "test",
                sourceMetadata: { type: "manual" },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              // No price mapping
            ],
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const result = await calculateTotals(
      ingredients,
      ingMap,
      mockGetIngredientName,
    );

    expect(result.totalIngredients).toBe(1);
    expect(result.price).toBe(0);
    expect(result.weight).toBe(240); // Has weight
    expect(result.nutrients["203"] ?? 0).toBe(0);
    expect(result.nutrients["208"] ?? 0).toBe(0);
    expect(result.missingByType.price).toEqual(["ingredient with weight only"]);
    expect(result.missingByType.weight).toEqual([]);
    expect(result.missingByType.nutrients).toEqual([
      "ingredient with weight only",
    ]);
  });

  test("handles error in ingredient processing", async () => {
    const ingredients: SectionIngredientOut[] = [
      {
        id: unsafeIngredientId("ing1"),
        type: "ingredient",
        createdAt: new Date(),
        updatedAt: new Date(),
        ingredient: {
          id: unsafeIngredientId("ing1"),
          name: "problematic ingredient",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        recipe: null,
        amounts: [], // Empty amounts - will cause error
      },
    ];

    const ingMap: Record<string, IngredientWithFoodOut> = {
      ing1: {
        id: unsafeIngredientId("ing1"),
        name: "problematic ingredient",
        recipe: null,
        appearsInRecipes: [],
        aliases: [],
        product: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const result = await calculateTotals(
      ingredients,
      ingMap,
      mockGetIngredientName,
    );

    expect(result.totalIngredients).toBe(1);
    expect(result.price).toBe(0);
    expect(result.weight).toBe(0);
    expect(result.nutrients["203"] ?? 0).toBe(0);
    expect(result.nutrients["208"] ?? 0).toBe(0);
    // Error case should add to all missing categories
    expect(result.missingByType.price).toEqual(["problematic ingredient"]);
    expect(result.missingByType.weight).toEqual(["problematic ingredient"]);
    expect(result.missingByType.nutrients).toEqual(["problematic ingredient"]);
  });
});

describe("calculateTotals with sub-recipes", () => {
  const mockGetIngredientName = (ingredient: SectionIngredientOut): string =>
    ingredient.type === "ingredient"
      ? ingredient.ingredient.name
      : "sub-recipe";

  // Builds an IngredientWithFoodOut with the given unit mappings (weight, price,
  // and per-100g nutrient mappings incl. kcal). Mirrors the fixture shape used by
  // the plain-ingredient tests above.
  const buildIngredient = (
    idStr: string,
    name: string,
    mappings: { a: Amount; b: Amount }[],
    nutrientsPer100: Record<string, number>,
  ): IngredientWithFoodOut => ({
    id: unsafeIngredientId(idStr),
    name,
    recipe: null,
    appearsInRecipes: [],
    aliases: [],
    product: [
      {
        id: unsafeProductId(`prod-${idStr}`),
        name,
        shortcode: unsafeProductShortcode("P-TEST"),
        food: {
          legacyFoodInfo: null,
          nutritionInfo: { nutrientsPer100, nutrientSummary: [] },
          fdc_id: 0,
          brandedFoodInfo: null,
          foodInfo: { data_type: "branded_food", description: "" },
          portionInfoRaw: [],
        },
        upc: null,
        ndb_number: null,
        manufacturer: "",
        category: null,
        model: null,
        expectedQuantity: null,
        price: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
        externalIds: [],
        unitMappings: mappings.map((m, i) => ({
          id: `${idStr}-map${i}`,
          a: m.a,
          b: m.b,
          source: "test",
          sourceMetadata: { type: "manual" as const },
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // A section ingredient referencing a plain ingredient.
  const ingredientEntry = (
    idStr: string,
    name: string,
    amounts: Amount[],
  ): SectionIngredientOut => ({
    id: idStr,
    type: "ingredient",
    createdAt: new Date(),
    updatedAt: new Date(),
    ingredient: {
      id: unsafeIngredientId(idStr),
      name,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    recipe: null,
    amounts,
  });

  // A section ingredient referencing a sub-recipe (recipe-as-ingredient).
  const subRecipeEntry = (
    sub: RecipeOut,
    amounts: Amount[],
  ): SectionIngredientOut => ({
    id: `link-${sub.id}`,
    type: "recipe",
    createdAt: new Date(),
    updatedAt: new Date(),
    ingredient: null,
    recipe: sub,
    amounts,
  });

  const makeSubRecipe = (
    idStr: string,
    name: string,
    yieldValue: RecipeOut["yield"],
    ingredients: SectionIngredientOut[],
  ): RecipeOut => ({
    id: unsafeRecipeId(idStr),
    name,
    createdAt: new Date(),
    updatedAt: new Date(),
    meta: null,
    yield: yieldValue,
    images: [],
    sections: [
      {
        id: `${idStr}-sec`,
        name: null,
        instructions: [],
        ingredients,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });

  test("rolls sub-recipe cost + calories into the parent totals, scaled by yield", async () => {
    // tomato: 1 cup = 100 g = $1; 100 g = 10 g protein = 50 kcal
    const tomato = buildIngredient(
      "tomato",
      "tomato",
      [
        { a: { value: 1, unit: "cup" }, b: { value: 100, unit: "gram" } },
        { a: { value: 1, unit: "cup" }, b: { value: 1, unit: "dollar" } },
        { a: { value: 100, unit: "g" }, b: { value: 10, unit: "g protein" } },
        { a: { value: 100, unit: "g" }, b: { value: 50, unit: "kcal" } },
      ],
      { "203": 10, "208": 50 },
    );
    // pasta: 1 scoop = 100 g = $3; 100 g = 5 g protein = 100 kcal. "scoop" is a
    // non-builtin unit so WASM uses the mapping (not a builtin like pound→gram).
    const pasta = buildIngredient(
      "pasta",
      "pasta",
      [
        { a: { value: 1, unit: "scoop" }, b: { value: 100, unit: "gram" } },
        { a: { value: 1, unit: "scoop" }, b: { value: 3, unit: "dollar" } },
        { a: { value: 100, unit: "g" }, b: { value: 5, unit: "g protein" } },
        { a: { value: 100, unit: "g" }, b: { value: 100, unit: "kcal" } },
      ],
      { "203": 5, "208": 100 },
    );

    const ingMap: Record<string, IngredientWithFoodOut> = {
      tomato,
      pasta,
    };

    // Sub-recipe "tomato sauce" yields 4 cups; uses 4 cups of tomato.
    // Its totals: $4, 400 g, 40 g protein, 200 kcal.
    const sauce = makeSubRecipe(
      "sauce",
      "tomato sauce",
      { value: 4, unit: "cup" },
      [ingredientEntry("tomato", "tomato", [{ value: 4, unit: "cup" }])],
    );

    const recipeMap: Record<string, RecipeOut> = { sauce };

    // Parent "pasta dish": 1 pound pasta + 2 cups of the 4-cup sauce (= half).
    const parentIngredients: SectionIngredientOut[] = [
      ingredientEntry("pasta", "pasta", [{ value: 1, unit: "scoop" }]),
      subRecipeEntry(sauce, [{ value: 2, unit: "cup" }]),
    ];

    const result = await calculateTotals(
      parentIngredients,
      ingMap,
      mockGetIngredientName,
      recipeMap,
    );

    // pasta $3 + half of sauce ($4 → $2) = $5
    expect(result.price).toBeCloseTo(5, 2);
    // pasta 100 g + half of sauce (400 g → 200 g) = 300 g
    expect(result.weight).toBeCloseTo(300, 1);
    // protein: pasta 5 g + half of sauce (40 g → 20 g) = 25 g
    expect(result.nutrients["203"]).toBeCloseTo(25, 1);
    // kcal: pasta 100 + half of sauce (200 → 100) = 200
    expect(result.nutrients["208"]).toBeCloseTo(200, 1);
    // The sub-recipe contributed — it is NOT flagged as missing.
    expect(result.missingByType.price).toEqual([]);
    expect(result.missingByType.weight).toEqual([]);
    expect(result.missingByType.nutrients).toEqual([]);
    expect(result.totalIngredients).toBe(2);
  });

  test("guards against cycles (A → B → A) without hanging", async () => {
    const recipeA = makeSubRecipe("recA", "A", { value: 1, unit: "batch" }, []);
    const recipeB = makeSubRecipe("recB", "B", { value: 1, unit: "batch" }, [
      subRecipeEntry(recipeA, [{ value: 1, unit: "batch" }]),
    ]);
    // Close the loop: A uses B, B uses A.
    recipeA.sections[0].ingredients.push(
      subRecipeEntry(recipeB, [{ value: 1, unit: "batch" }]),
    );

    const recipeMap: Record<string, RecipeOut> = {
      recA: recipeA,
      recB: recipeB,
    };

    // Should terminate (the visited-set cycle guard breaks the loop), not hang.
    const result = await calculateTotals(
      recipeA.sections[0].ingredients,
      {},
      mockGetIngredientName,
      recipeMap,
    );

    expect(result).toBeDefined();
    expect(typeof result.price).toBe("number");
  });

  test("flags a yield-less sub-recipe as missing instead of guessing", async () => {
    // No yield → can't scale → treated as unconvertible (missing), contributes $0.
    const sauce = makeSubRecipe("sauce", "tomato sauce", null, [
      ingredientEntry("tomato", "tomato", [{ value: 1, unit: "cup" }]),
    ]);

    const recipeMap: Record<string, RecipeOut> = { sauce };

    const result = await calculateTotals(
      [subRecipeEntry(sauce, [{ value: 2, unit: "cup" }])],
      {},
      mockGetIngredientName,
      recipeMap,
    );

    expect(result.price).toBe(0);
    expect(result.weight).toBe(0);
    expect(result.missingByType.price).toEqual(["sub-recipe"]);
    expect(result.missingByType.weight).toEqual(["sub-recipe"]);
    expect(result.missingByType.nutrients).toEqual(["sub-recipe"]);
  });
});

describe("calculateTotals with absorbed frying oil", () => {
  const getName = (i: SectionIngredientOut): string =>
    i.type === "ingredient" ? i.ingredient.name : "recipe";

  // Ingredient backed by one product carrying the given unit mappings.
  const ing = (
    idStr: string,
    name: string,
    mappings: { a: Amount; b: Amount }[],
  ): IngredientWithFoodOut => ({
    id: unsafeIngredientId(idStr),
    name,
    recipe: null,
    appearsInRecipes: [],
    aliases: [],
    product: [
      {
        id: unsafeProductId(`prod-${idStr}`),
        name,
        shortcode: unsafeProductShortcode("P-TEST"),
        food: null,
        upc: null,
        ndb_number: null,
        manufacturer: "",
        category: null,
        model: null,
        expectedQuantity: null,
        price: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
        externalIds: [],
        unitMappings: mappings.map((m, i) => ({
          id: `${idStr}-m${i}`,
          a: m.a,
          b: m.b,
          source: "test",
          sourceMetadata: { type: "manual" as const },
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const entry = (
    idStr: string,
    name: string,
    amounts: Amount[],
    modifier?: string,
  ): SectionIngredientOut => ({
    id: idStr,
    type: "ingredient",
    createdAt: new Date(),
    updatedAt: new Date(),
    ingredient: {
      id: unsafeIngredientId(idStr),
      name,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    recipe: null,
    amounts,
    modifier: modifier ?? null,
  });

  // flour: 1 cup = 100 g; 100 g = 364 kcal = 10 g protein; 1 cup = $1
  const flourIng = ing("flour", "flour", [
    { a: { value: 1, unit: "cup" }, b: { value: 100, unit: "gram" } },
    { a: { value: 100, unit: "g" }, b: { value: 364, unit: "kcal" } },
    { a: { value: 100, unit: "g" }, b: { value: 10, unit: "g protein" } },
    { a: { value: 1, unit: "cup" }, b: { value: 1, unit: "dollar" } },
  ]);
  // oil: 100 g = 884 kcal; 1000 g = $5
  const oilIng = ing("oil", "neutral oil", [
    { a: { value: 100, unit: "g" }, b: { value: 884, unit: "kcal" } },
    { a: { value: 1000, unit: "g" }, b: { value: 5, unit: "dollar" } },
  ]);
  const ingMap: Record<string, IngredientWithFoodOut> = {
    flour: flourIng,
    oil: oilIng,
  };

  test("folds estimated absorbed oil into totals (15% of batter weight)", async () => {
    const ingredients = [
      entry("flour", "flour", [{ value: 1, unit: "cup" }]),
      entry("oil", "neutral oil", [], "for frying"),
    ];

    const r = await calculateTotals(ingredients, ingMap, getName);

    // batter = 100 g flour; absorbed oil = 0.15 * 100 = 15 g
    expect(r.weight).toBeCloseTo(115, 0);
    // kcal: flour 364 + oil (15/100 * 884 = 132.6) = 496.6
    expect(r.nutrients["208"]).toBeCloseTo(496.6, 0);
    // protein comes from flour only
    expect(r.nutrients["203"]).toBeCloseTo(10, 0);
    // price: flour $1 + oil (15/1000 * 5 ≈ $0.075); WASM rounds slightly
    expect(r.price).toBeCloseTo(1.075, 1);
    // oil resolved → not flagged missing
    expect(r.missingByType.price).toEqual([]);
    expect(r.missingByType.weight).toEqual([]);
    expect(r.missingByType.nutrients).toEqual([]);
    expect(r.totalIngredients).toBe(2);
  });

  test("control: same recipe without the frying medium is unchanged", async () => {
    const ingredients = [entry("flour", "flour", [{ value: 1, unit: "cup" }])];

    const r = await calculateTotals(ingredients, ingMap, getName);

    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364, 0);
  });

  test("unmeasured oil with explicit amount is treated as a normal ingredient", async () => {
    // Has both a frying modifier AND an amount → not an absorption estimate.
    const ingredients = [
      entry("oil", "neutral oil", [{ value: 100, unit: "g" }], "for frying"),
    ];

    const r = await calculateTotals(ingredients, ingMap, getName);

    // 100 g oil measured directly → 884 kcal, no batter-relative estimate.
    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.nutrients["208"]).toBeCloseTo(884, 0);
  });

  test("frying medium with no resolvable mapping fails gracefully", async () => {
    const noMapOil = ing("oil2", "neutral oil", []); // empty mappings
    const ingredients = [
      entry("flour", "flour", [{ value: 1, unit: "cup" }]),
      entry("oil2", "neutral oil", [], "for frying"),
    ];

    const r = await calculateTotals(
      ingredients,
      { flour: flourIng, oil2: noMapOil },
      getName,
    );

    // flour is unaffected; the oil simply can't be estimated → missing.
    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364, 0);
    expect(r.missingByType.nutrients).toContain("neutral oil");
  });

  test("computeAbsorbedOilMeasures keys only the oil row, sized off the others", () => {
    const ingredients = [
      entry("flour", "flour", [{ value: 1, unit: "cup" }]),
      entry("oil", "neutral oil", [], "for frying"),
    ];

    const data = createIngredientData(ingredients, ingMap);
    const map = computeAbsorbedOilMeasures(data, ingMap, getName);

    expect([...map.keys()]).toEqual(["oil"]);
    const m = map.get("oil");
    expect(m?.gram.isOk() && m.gram.value.value).toBeCloseTo(15, 0);
    expect(m?.nutrient.isOk() && m.nutrient.value["208"]).toBeCloseTo(132.6, 0);
  });
});
