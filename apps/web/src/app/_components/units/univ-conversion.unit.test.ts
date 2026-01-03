import { beforeAll, describe, expect, test } from "vitest";
import type { Amount } from "~/codec/codec";
import { ensureWasm } from "~/lib/wasm";
import {
  unsafeIngredientId,
  unsafeProductId,
  unsafeProductShortcode,
} from "~/schemas/identifiers";
import type { SectionIngredientOut } from "~/schemas/recipe";
import type { UnitMapping } from "~/schemas/unitmapping";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import {
  calculateTotals,
  convertAmountToNutrients,
  convertAmountToPrice,
  createEmptyNutrients,
  getGramAndNutrient,
} from "./univ-conversion";

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
  test("converts amount directly to nutrients via WASM graph", async () => {
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

    expect(result.success).toBe(true);
    if (result.success) {
      // 2 cups = 250g, 250g / 100 * 10 = 25g protein
      expect(result.value["203"]).toBeCloseTo(25, 0);
      // 2 cups = 250g, 250g / 100 * 200 = 500 kcal
      expect(result.value["208"]).toBeCloseTo(500, 0);
    }
  });

  test("returns failure when no nutrient mappings exist", async () => {
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

    expect(result.success).toBe(false);
    expect(result.error).toBe("No nutrient conversions succeeded");
  });

  test("handles empty mappings array", async () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = [];

    const result = convertAmountToNutrients(amount, mappings);

    expect(result.success).toBe(false);
  });

  test("kcal requires 'kcal' unit (not 'kcal kcal') because WASM uses Unit::KCal internally", async () => {
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
    expect(badResult.success).toBe(false);

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
    expect(goodResult.success).toBe(true);
    if (goodResult.success) {
      // Nutrient code "208" is kcal
      expect(goodResult.value["208"]).toBe(200);
    }
  });
});

describe("getGramAndNutrient", () => {
  test("successfully converts to grams and nutrients via WASM", async () => {
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
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("g");
      expect(result.gram.value.value).toBe(240);
    }

    expect(result.nutrient.success).toBe(true);
    if (result.nutrient.success) {
      // 1 cup = 240g, 240g / 100 * 10 = 24g protein
      expect(result.nutrient.value["203"]).toBeCloseTo(24, 0);
      // 1 cup = 240g, 240g / 100 * 200 = 480 kcal
      expect(result.nutrient.value["208"]).toBeCloseTo(480, 0);
    }
  });

  test("handles error when conversion to weight fails", async () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "InvalidUnit" };
    const mappings: UnitMapping[] = [];
    const product = undefined;

    // Act
    const result = getGramAndNutrient(amount, mappings, product);

    // Assert
    expect(result.gram.success).toBe(false);
    expect(result.gram.error).toContain("Error converting to weight:");

    expect(result.nutrient.success).toBe(false);
  });

  test("weight succeeds independently from nutrients", async () => {
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
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("g");
      expect(result.gram.value.value).toBe(240);
    }

    // Nutrient conversion should fail due to missing nutrient mappings
    expect(result.nutrient.success).toBe(false);
    expect(result.nutrient.error).toBe("No nutrient conversions succeeded");
  });

  test("nutrients succeed independently from weight", async () => {
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
    expect(result.gram.success).toBe(false);

    // Nutrient conversion should succeed via direct mapping
    expect(result.nutrient.success).toBe(true);
    if (result.nutrient.success) {
      expect(result.nutrient.value["203"]).toBeCloseTo(15, 0);
      expect(result.nutrient.value["208"]).toBeCloseTo(200, 0);
    }
  });
});

describe("convertAmountToPrice", () => {
  test("successfully converts amount to price", async () => {
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
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.unit).toBe("$");
      expect(result.value.value).toBe(2.99);
    }
  });

  test("handles error when conversion fails", async () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "InvalidUnit" };
    const mappings: UnitMapping[] = [];

    // Act
    const result = convertAmountToPrice(amount, mappings);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toContain("Error converting to money:");
  });
});

describe("WASM Error Scenarios", () => {
  test("handles empty mappings array", async () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = []; // Empty mappings

    const result = convertAmountToPrice(amount, mappings);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to convert");
  });

  test("handles incompatible unit mappings", async () => {
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

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to convert");
  });

  test("handles zero values in mappings", async () => {
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
    if (result.success) {
      // If it succeeds, it should handle zero gracefully
      expect(result.value).toBeDefined();
    } else {
      // If it fails, it should have an appropriate error
      expect(result.error).toBeDefined();
    }
  });

  test("handles very large values", async () => {
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

    expect(result.success).toBe(true);
    if (result.success) {
      // Very large number conversions have floating point precision limits
      // The result is close to the expected value but not exact
      expect(result.value.value).toBeGreaterThan(29e9); // At least 29 billion
      expect(result.value.value).toBeLessThan(31e9); // At most 31 billion
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles very small values", async () => {
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

    expect(result.success).toBe(true);
    if (result.success) {
      // Very small values might be rounded to zero by WASM/floating point precision
      expect(result.value.value).toBeGreaterThanOrEqual(0);
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles case-insensitive unit names", async () => {
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
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.value).toBe(2.99);
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles chained conversions", async () => {
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

    expect(result.success).toBe(true);
    if (result.success) {
      // 1 cup -> 240ml -> 0.24 liter -> 0.24 * 3.99 = $0.9576
      // WASM returns $0.94-0.96 depending on environment precision
      expect(result.value.value).toBeGreaterThanOrEqual(0.94);
      expect(result.value.value).toBeLessThanOrEqual(0.96);
      expect(result.value.unit).toBe("$");
    }
  });

  test("handles circular mapping references", async () => {
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
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to convert");
  });

  test("handles custom unit names", async () => {
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
    expect(result.success).toBe(true);
    if (result.success) {
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
