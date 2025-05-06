import { expect, test, describe } from "vitest";
import { getGramAndNutrient, convertAmountToPrice } from "./univ-conversion";
import { type Amount } from "~/codec/codec";
import { type UnitMapping } from "~/schemas/unitmapping";
import { ProductWithMappingsAndFoodOut } from "~/schemas/combo";

// Import real wasm
const loadWasm = async () => {
  const wasm = await import("recipebridge/pkg/recipebridge");
  return wasm;
};

describe("getGramAndNutrient", () => {
  test("successfully converts to grams and calculates nutrients", async () => {
    // Arrange
    const wasm = await loadWasm();
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
      },
    ];

    const product: ProductWithMappingsAndFoodOut[] = [
      {
        id: "123",
        name: "Test Product",
        food: {
          legacyFoodInfo: null,
          nutritionInfo: {
            nutrientsPer100: {
              protein: 10,
              kcal: 200,
            },
            nutrientSummary: [],
          },
          fdc_id: 0,
          brandedFoodInfo: null,
          foodInfo: {
            data_type: "",
            description: "",
          },
          portionInfo: {
            raw: [],
            parsed: [],
          },
        },
        upc: null,
        ndb_number: null,
        manufacturer: "",
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        unitMappings: [],
      },
    ];

    const result = getGramAndNutrient(wasm, amount, mappings, product);

    // Assert
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("Gram");
      expect(result.gram.value.value).toBe(240);
    }

    expect(result.nutrient.success).toBe(true);
    expect(result.nutrient.value).toEqual({
      protein: 24, // (240/100) * 10
      kcal: 480, // (240/100) * 200
    });
  });

  test("handles error when conversion to weight fails", async () => {
    // Arrange
    const wasm = await loadWasm();
    const amount: Amount = { value: 1, unit: "InvalidUnit" };
    const mappings: UnitMapping[] = [];
    const product = undefined;

    // Act
    const result = getGramAndNutrient(wasm, amount, mappings, product);

    // Assert
    expect(result.gram.success).toBe(false);
    expect(result.gram.error).toContain("convert to weight:");

    expect(result.nutrient.success).toBe(false);
  });

  test("handles missing nutrient data", async () => {
    // Arrange
    const wasm = await loadWasm();
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
      },
    ];
    const product: ProductWithMappingsAndFoodOut[] = [
      {
        id: "123",
        name: "Test Product",
        food: null, // No nutritionInfo
        unitMappings: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        upc: null,
        ndb_number: null,
        manufacturer: "",
        model: null,
      },
    ];

    // Act
    const result = getGramAndNutrient(wasm, amount, mappings, product);

    // Assert
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("Gram");
      expect(result.gram.value.value).toBe(240);
    }

    expect(result.nutrient.success).toBe(false);
    expect(result.nutrient.error).toBe("product(s) have no nutrients");
  });

  test("handles undefined product", async () => {
    // Arrange
    const wasm = await loadWasm();
    const amount: Amount = { value: 1, unit: "Cup" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Cup" },
        b: { value: 240, unit: "gram" },
        source: "test",
      },
    ];
    const product = undefined;

    // Act
    const result = getGramAndNutrient(wasm, amount, mappings, product);

    // Assert
    expect(result.gram.success).toBe(true);
    if (result.gram.success) {
      expect(result.gram.value.unit).toBe("Gram");
      expect(result.gram.value.value).toBe(240);
    }

    expect(result.nutrient.success).toBe(false);
    expect(result.nutrient.error).toBe("product(s) have no nutrients");
  });
});

describe("convertAmountToPrice", () => {
  test("successfully converts amount to price", async () => {
    // Arrange
    const wasm = await loadWasm();
    const amount: Amount = { value: 1, unit: "Pound" };
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "Pound" },
        b: { value: 2.99, unit: "Dollar" },
        source: "test",
      },
    ];

    // Act
    const result = convertAmountToPrice(wasm, amount, mappings);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.unit).toBe("Dollar");
      expect(result.value.value).toBe(2.99);
    }
  });

  test("handles error when conversion fails", async () => {
    // Arrange
    const wasm = await loadWasm();
    const amount: Amount = { value: 1, unit: "InvalidUnit" };
    const mappings: UnitMapping[] = [];

    // Act
    const result = convertAmountToPrice(wasm, amount, mappings);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "conv_measure_to_kind: failed to convert '1 invalidunit' to target measure 'Money'",
    );
  });
});
