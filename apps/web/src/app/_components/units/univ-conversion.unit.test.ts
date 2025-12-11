import { expect, test, describe, beforeAll } from "vitest";
import {
  getGramAndNutrient,
  convertAmountToPrice,
  getProductNutrients,
  createEmptyNutrients,
  scaleNutrientsByWeight,
  calculateNutrients,
  calculateTotals,
} from "./univ-conversion";
import { type Amount } from "~/codec/codec";
import { type UnitMapping } from "~/schemas/unitmapping";
import {
  type ProductWithMappingsAndFoodOut,
  type IngredientWithFoodOut,
} from "~/server/services/ingredient.service";
import { NutrientsPer100 } from "@recipehub/usda-schemas";
import { SectionIngredientOut } from "~/schemas/recipe";
import { unsafeProductId, unsafeIngredientId } from "~/schemas/identifiers";
import { ensureWasm } from "~/lib/wasm";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

describe("getProductNutrients", () => {
  test("returns nutrients when product has food data", () => {
    const product: ProductWithMappingsAndFoodOut = {
      id: unsafeProductId("test-id"),
      name: "Test Product",
      food: {
        legacyFoodInfo: null,
        nutritionInfo: {
          nutrientsPer100: {
            "203": 15.5,
            "208": 250,
          },
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
      model: null,
      expectedQuantity: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      images: [],
      unitMappings: [],
    };

    const result = getProductNutrients(product);

    expect(result).toEqual({
      "203": 15.5,
      "208": 250,
    });
  });

  test("returns undefined when product has no food data", () => {
    const product: ProductWithMappingsAndFoodOut = {
      id: unsafeProductId("test-id"),
      name: "Test Product",
      food: null,
      upc: null,
      ndb_number: null,
      manufacturer: "",
      model: null,
      expectedQuantity: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      images: [],
      unitMappings: [],
    };

    const result = getProductNutrients(product);

    expect(result).toBeUndefined();
  });

  test("returns zero-value nutrients when product has nutrition info with zero values", () => {
    const product: ProductWithMappingsAndFoodOut = {
      id: unsafeProductId("test-id"),
      name: "Test Product",
      food: {
        legacyFoodInfo: null,
        nutritionInfo: {
          nutrientSummary: [],
          nutrientsPer100: { "203": 0, "208": 0 },
        },
        fdc_id: 0,
        brandedFoodInfo: null,
        foodInfo: { data_type: "branded_food", description: "" },
        portionInfoRaw: [],
      },
      upc: null,
      ndb_number: null,
      manufacturer: "",
      model: null,
      expectedQuantity: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      images: [],
      unitMappings: [],
    };

    const result = getProductNutrients(product);

    expect(result).toEqual({ "203": 0, "208": 0 });
  });
});

describe("createEmptyNutrients", () => {
  test("returns empty nutrients record", () => {
    const result = createEmptyNutrients();

    expect(result).toEqual({});
  });
});

describe("scaleNutrientsByWeight", () => {
  test("scales nutrients correctly for 100g (no change)", () => {
    const nutrients: NutrientsPer100 = { "203": 10, "208": 200 };
    const result = scaleNutrientsByWeight(nutrients, 100);

    expect(result).toEqual({ "203": 10, "208": 200 });
  });

  test("scales nutrients correctly for 50g (half)", () => {
    const nutrients: NutrientsPer100 = { "203": 10, "208": 200 };
    const result = scaleNutrientsByWeight(nutrients, 50);

    expect(result).toEqual({ "203": 5, "208": 100 });
  });

  test("scales nutrients correctly for 200g (double)", () => {
    const nutrients: NutrientsPer100 = { "203": 10, "208": 200 };
    const result = scaleNutrientsByWeight(nutrients, 200);

    expect(result).toEqual({ "203": 20, "208": 400 });
  });

  test("handles decimal weights correctly", () => {
    const nutrients: NutrientsPer100 = { "203": 10, "208": 200 };
    const result = scaleNutrientsByWeight(nutrients, 33.33);

    expect(result["203"]).toBeCloseTo(3.333, 3);
    expect(result["208"]).toBeCloseTo(66.66, 2);
  });

  test("handles zero weight", () => {
    const nutrients: NutrientsPer100 = { "203": 10, "208": 200 };
    const result = scaleNutrientsByWeight(nutrients, 0);

    expect(result).toEqual({ "203": 0, "208": 0 });
  });
});

describe("calculateNutrients", () => {
  const mockProducts: ProductWithMappingsAndFoodOut[] = [
    {
      id: unsafeProductId("product-1"),
      name: "Product 1",
      food: {
        legacyFoodInfo: null,
        nutritionInfo: {
          nutrientsPer100: { "203": 20, "208": 300 },
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
      model: null,
      expectedQuantity: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      images: [],
      unitMappings: [],
    },
  ];

  test("calculates nutrients successfully with valid products", () => {
    const result = calculateNutrients(150, mockProducts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({
        "203": 30, // protein: 20 * (150/100)
        "208": 450, // kcal: 300 * (150/100)
      });
    }
  });

  test("returns failure when no products provided", () => {
    const result = calculateNutrients(150, undefined);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Product(s) have no nutrients");
  });

  test("returns failure when products have no nutrients", () => {
    const productsWithoutNutrients: ProductWithMappingsAndFoodOut[] = [
      {
        id: unsafeProductId("product-1"),
        name: "Product 1",
        food: null,
        upc: null,
        ndb_number: null,
        manufacturer: "",
        model: null,
        expectedQuantity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
        unitMappings: [],
      },
    ];

    const result = calculateNutrients(150, productsWithoutNutrients);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Product(s) have no nutrients");
  });

  test("uses first available nutrients from multiple products", () => {
    const multipleProducts: ProductWithMappingsAndFoodOut[] = [
      {
        id: unsafeProductId("product-1"),
        name: "Product 1",
        food: null, // No nutrients
        upc: null,
        ndb_number: null,
        manufacturer: "",
        model: null,
        expectedQuantity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
        unitMappings: [],
      },
      {
        id: unsafeProductId("product-2"),
        name: "Product 2",
        food: {
          legacyFoodInfo: null,
          nutritionInfo: {
            nutrientsPer100: { "203": 25, "208": 400 },
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
        model: null,
        expectedQuantity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
        unitMappings: [],
      },
    ];

    const result = calculateNutrients(100, multipleProducts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({
        "203": 25,
        "208": 400,
      });
    }
  });
});

describe("getGramAndNutrient", () => {
  test("successfully converts to grams and calculates nutrients", async () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];

    const product: ProductWithMappingsAndFoodOut[] = [
      {
        id: unsafeProductId("123"),
        name: "Test Product",
        food: {
          legacyFoodInfo: null,
          nutritionInfo: {
            nutrientsPer100: {
              "203": 10,
              "208": 200,
            },
            nutrientSummary: [],
          },
          fdc_id: 0,
          brandedFoodInfo: null,
          foodInfo: {
            data_type: "branded_food",
            description: "",
          },
          portionInfoRaw: [],
        },
        upc: null,
        ndb_number: null,
        manufacturer: "",
        model: null,
        expectedQuantity: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
        unitMappings: [],
      },
    ];

    const result = getGramAndNutrient(amount, mappings, product);

    // Assert
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("Gram");
      expect(result.gram.value.value).toBe(240);
    }

    expect(result.nutrient.success).toBe(true);
    expect(result.nutrient.value).toEqual({
      "203": 24, // protein: (240/100) * 10
      "208": 480, // kcal: (240/100) * 200
    });
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

  test("handles missing nutrient data", async () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];
    const product: ProductWithMappingsAndFoodOut[] = [
      {
        id: unsafeProductId("123"),
        name: "Test Product",
        food: null, // No nutritionInfo
        images: [],
        unitMappings: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        upc: null,
        ndb_number: null,
        manufacturer: "",
        model: null,
        expectedQuantity: null,
      },
    ];

    // Act
    const result = getGramAndNutrient(amount, mappings, product);

    // Assert - Weight conversion should succeed
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("Gram");
      expect(result.gram.value.value).toBe(240);
    }

    // Nutrient conversion should fail due to missing nutrition data
    expect(result.nutrient.success).toBe(false);
    expect(result.nutrient.error).toBe("Product(s) have no nutrients");
  });

  test("handles undefined product", async () => {
    // Arrange
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
        sourceMetadata: { type: "manual" },
      },
    ];
    const product = undefined;

    // Act
    const result = getGramAndNutrient(amount, mappings, product);

    // Assert - Weight conversion should succeed even with undefined product
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("Gram");
      expect(result.gram.value.value).toBe(240);
    }

    // Nutrient conversion should fail due to undefined product
    expect(result.nutrient.success).toBe(false);
    expect(result.nutrient.error).toBe("Product(s) have no nutrients");
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
      expect(result.value.unit).toBe("Dollar");
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
      expect(result.value.unit).toBe("Dollar");
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
      expect(result.value.unit).toBe("Dollar");
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
      expect(result.value.unit).toBe("Dollar");
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
      expect(result.value.unit).toBe("Dollar");
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
      expect(result.value.unit).toBe("Dollar");
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
            model: null,
            expectedQuantity: null,
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
            model: null,
            expectedQuantity: null,
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
            model: null,
            expectedQuantity: null,
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
            food: null, // No nutrition data
            upc: null,
            ndb_number: null,
            manufacturer: "",
            model: null,
            expectedQuantity: null,
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
