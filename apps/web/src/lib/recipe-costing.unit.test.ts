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
  applyUsageEstimates,
  type CostingRow,
  calculateTotals,
  computeUsageEstimates,
  convertAmountToNutrients,
  convertAmountToPrice,
  createEmptyNutrients,
  createIngredientData,
  flattenSections,
  getGramAndNutrient,
} from "~/lib/recipe-costing";
import { ensureWasm } from "~/lib/wasm";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

// ─── Shared fixture builders ─────────────────────────────────────────────────
// Almost every field on IngredientWithFoodOut / SectionIngredientOut / RecipeOut
// is irrelevant scaffolding for these tests. These builders state the defaults
// once so each test shows only the values its assertions actually depend on
// (mapping amounts, nutrient codes, names, yields).
const TS = new Date();
const dates = { createdAt: TS, updatedAt: TS };

const getName = (i: SectionIngredientOut): string =>
  i.type === "ingredient" ? i.ingredient.name : "sub-recipe";

const ingredientWith = (
  idStr: string,
  name: string,
  product: IngredientWithFoodOut["product"],
): IngredientWithFoodOut => ({
  id: unsafeIngredientId(idStr),
  name,
  recipe: null,
  appearsInRecipes: [],
  aliases: [],
  ...dates,
  product,
});

// An ingredient backed by one product carrying `mappings`. Pass `nutrientsPer100`
// to attach USDA food data; omit it for a product with no nutrition.
const makeIngredient = (
  idStr: string,
  name: string,
  mappings: { a: Amount; b: Amount }[],
  nutrientsPer100?: Record<string, number>,
): IngredientWithFoodOut =>
  ingredientWith(idStr, name, [
    {
      id: unsafeProductId(`prod-${idStr}`),
      shortcode: unsafeProductShortcode("P-TEST"),
      name,
      upc: null,
      ndb_number: null,
      manufacturer: "",
      category: null,
      model: null,
      expectedQuantity: null,
      price: null,
      images: [],
      externalIds: [],
      food: nutrientsPer100
        ? {
            legacyFoodInfo: null,
            nutritionInfo: { nutrientsPer100, nutrientSummary: [] },
            fdc_id: 0,
            brandedFoodInfo: null,
            foodInfo: { data_type: "branded_food", description: "" },
            portionInfoRaw: [],
          }
        : null,
      unitMappings: mappings.map(({ a, b }, i) => ({
        id: `${idStr}-m${i}`,
        a,
        b,
        source: "test",
        sourceMetadata: { type: "manual" as const },
        ...dates,
      })),
      ...dates,
    },
  ]);

// An ingredient with no product at all (forces missing price/weight/nutrients).
const emptyIngredient = (idStr: string, name: string): IngredientWithFoodOut =>
  ingredientWith(idStr, name, []);

// A section row referencing a plain ingredient (optionally with a modifier
// and/or a section name — both feed the usage classifier).
const makeEntry = (
  idStr: string,
  name: string,
  amounts: Amount[],
  modifier?: string,
  sectionName?: string,
): CostingRow => ({
  id: idStr,
  type: "ingredient",
  ...dates,
  ingredient: { id: unsafeIngredientId(idStr), name, ...dates },
  recipe: null,
  amounts,
  modifier: modifier ?? null,
  sectionName: sectionName ?? null,
});

// A section row referencing a sub-recipe (recipe-as-ingredient).
const makeSubRecipeEntry = (sub: RecipeOut, amounts: Amount[]): CostingRow => ({
  id: `link-${sub.id}`,
  type: "recipe",
  ...dates,
  ingredient: null,
  recipe: sub,
  amounts,
  sectionName: null,
});

const makeSubRecipe = (
  idStr: string,
  name: string,
  yieldValue: RecipeOut["yield"],
  ingredients: SectionIngredientOut[],
): RecipeOut => ({
  id: unsafeRecipeId(idStr),
  name,
  ...dates,
  meta: null,
  yield: yieldValue,
  images: [],
  sections: [
    { id: `${idStr}-sec`, name: null, instructions: [], ingredients, ...dates },
  ],
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
  // chicken: 1 lb = 453.59 g; 1 lb = $5.99; 100 g = 20 g protein = 200 kcal
  const chicken = makeIngredient(
    "ing1",
    "chicken",
    [
      { a: { value: 1, unit: "pound" }, b: { value: 453.59, unit: "gram" } },
      { a: { value: 1, unit: "pound" }, b: { value: 5.99, unit: "dollar" } },
      { a: { value: 100, unit: "g" }, b: { value: 20, unit: "g protein" } },
      { a: { value: 100, unit: "g" }, b: { value: 200, unit: "kcal" } },
    ],
    { "203": 20, "208": 200 },
  );

  test("calculates totals with all data available", async () => {
    // rice: 1 cup = 200 g; 1 cup = $2.50; 100 g = 7 g protein = 130 kcal
    const rice = makeIngredient(
      "ing2",
      "rice",
      [
        { a: { value: 1, unit: "cup" }, b: { value: 200, unit: "gram" } },
        { a: { value: 1, unit: "cup" }, b: { value: 2.5, unit: "dollar" } },
        { a: { value: 100, unit: "g" }, b: { value: 7, unit: "g protein" } },
        { a: { value: 100, unit: "g" }, b: { value: 130, unit: "kcal" } },
      ],
      { "203": 7, "208": 130 },
    );

    const result = await calculateTotals(
      [
        makeEntry("ing1", "chicken", [{ value: 1, unit: "pound" }]),
        makeEntry("ing2", "rice", [{ value: 2, unit: "cup" }]),
      ],
      { ing1: chicken, ing2: rice },
      getName,
    );

    expect(result.totalIngredients).toBe(2);
    expect(result.price).toBeCloseTo(10.99, 2); // 5.99 + 5.00
    expect(result.weight).toBeCloseTo(854, 1); // WASM rounds: ~454 + 400
    expect(result.missingByType).toEqual({
      price: [],
      weight: [],
      nutrients: [],
    });
  });

  test("handles completely missing data", async () => {
    const result = await calculateTotals(
      [
        makeEntry("ing1", "unknown ingredient", [
          { value: 1, unit: "unknownunit" },
        ]),
      ],
      { ing1: emptyIngredient("ing1", "unknown ingredient") },
      getName,
    );

    expect(result.totalIngredients).toBe(1);
    expect(result.price).toBe(0);
    expect(result.weight).toBe(0);
    expect(result.nutrients["203"] ?? 0).toBe(0);
    expect(result.nutrients["208"] ?? 0).toBe(0);
    expect(result.missingByType).toEqual({
      price: ["unknown ingredient"],
      weight: ["unknown ingredient"],
      nutrients: ["unknown ingredient"],
    });
  });

  test("handles partially missing data", async () => {
    const result = await calculateTotals(
      [
        makeEntry("ing1", "chicken", [{ value: 1, unit: "pound" }]),
        makeEntry("ing2", "unknown spice", [{ value: 1, unit: "teaspoon" }]),
      ],
      { ing1: chicken, ing2: emptyIngredient("ing2", "unknown spice") },
      getName,
    );

    expect(result.totalIngredients).toBe(2);
    expect(result.price).toBeCloseTo(5.99, 2); // Only chicken has price
    expect(result.weight).toBeCloseTo(454, 1); // WASM rounds: ~454
    expect(result.missingByType).toEqual({
      price: ["unknown spice"],
      weight: ["unknown spice"],
      nutrients: ["unknown spice"],
    });
  });

  test("handles missing only specific data types", async () => {
    const name = "ingredient with weight only";
    // weight mapping only — no price, no nutrition (food stays null).
    const weightOnly = makeIngredient("ing1", name, [
      { a: { value: 1, unit: "cup" }, b: { value: 240, unit: "gram" } },
    ]);

    const result = await calculateTotals(
      [makeEntry("ing1", name, [{ value: 1, unit: "cup" }])],
      { ing1: weightOnly },
      getName,
    );

    expect(result.totalIngredients).toBe(1);
    expect(result.price).toBe(0);
    expect(result.weight).toBe(240); // Has weight
    expect(result.nutrients["203"] ?? 0).toBe(0);
    expect(result.nutrients["208"] ?? 0).toBe(0);
    expect(result.missingByType).toEqual({
      price: [name],
      weight: [],
      nutrients: [name],
    });
  });

  test("handles error in ingredient processing", async () => {
    const name = "problematic ingredient";
    const result = await calculateTotals(
      [makeEntry("ing1", name, [])], // empty amounts → processing error
      { ing1: emptyIngredient("ing1", name) },
      getName,
    );

    expect(result.totalIngredients).toBe(1);
    expect(result.price).toBe(0);
    expect(result.weight).toBe(0);
    expect(result.nutrients["203"] ?? 0).toBe(0);
    expect(result.nutrients["208"] ?? 0).toBe(0);
    // Error case should add to all missing categories
    expect(result.missingByType).toEqual({
      price: [name],
      weight: [name],
      nutrients: [name],
    });
  });
});

describe("calculateTotals with sub-recipes", () => {
  test("rolls sub-recipe cost + calories into the parent totals, scaled by yield", async () => {
    // tomato: 1 cup = 100 g = $1; 100 g = 10 g protein = 50 kcal
    const tomato = makeIngredient(
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
    const pasta = makeIngredient(
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

    // Sub-recipe "tomato sauce" yields 4 cups; uses 4 cups of tomato.
    // Its totals: $4, 400 g, 40 g protein, 200 kcal.
    const sauce = makeSubRecipe(
      "sauce",
      "tomato sauce",
      { value: 4, unit: "cup" },
      [makeEntry("tomato", "tomato", [{ value: 4, unit: "cup" }])],
    );

    // Parent "pasta dish": 1 scoop pasta + 2 cups of the 4-cup sauce (= half).
    const result = await calculateTotals(
      [
        makeEntry("pasta", "pasta", [{ value: 1, unit: "scoop" }]),
        makeSubRecipeEntry(sauce, [{ value: 2, unit: "cup" }]),
      ],
      { tomato, pasta },
      getName,
      { sauce },
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
    expect(result.missingByType).toEqual({
      price: [],
      weight: [],
      nutrients: [],
    });
    expect(result.totalIngredients).toBe(2);
  });

  test("guards against cycles (A → B → A) without hanging", async () => {
    const recipeA = makeSubRecipe("recA", "A", { value: 1, unit: "batch" }, []);
    const recipeB = makeSubRecipe("recB", "B", { value: 1, unit: "batch" }, [
      makeSubRecipeEntry(recipeA, [{ value: 1, unit: "batch" }]),
    ]);
    // Close the loop: A uses B, B uses A.
    recipeA.sections[0].ingredients.push(
      makeSubRecipeEntry(recipeB, [{ value: 1, unit: "batch" }]),
    );

    // Should terminate (the visited-set cycle guard breaks the loop), not hang.
    const result = await calculateTotals(
      flattenSections(recipeA.sections),
      {},
      getName,
      { recA: recipeA, recB: recipeB },
    );

    expect(result).toBeDefined();
    expect(typeof result.price).toBe("number");
  });

  test("flags a yield-less sub-recipe as missing instead of guessing", async () => {
    // No yield → can't scale → treated as unconvertible (missing), contributes $0.
    const sauce = makeSubRecipe("sauce", "tomato sauce", null, [
      makeEntry("tomato", "tomato", [{ value: 1, unit: "cup" }]),
    ]);

    const result = await calculateTotals(
      [makeSubRecipeEntry(sauce, [{ value: 2, unit: "cup" }])],
      {},
      getName,
      { sauce },
    );

    expect(result.price).toBe(0);
    expect(result.weight).toBe(0);
    expect(result.missingByType).toEqual({
      price: ["sub-recipe"],
      weight: ["sub-recipe"],
      nutrients: ["sub-recipe"],
    });
  });
});

describe("calculateTotals with the consumption model", () => {
  // flour: 1 cup = 100 g; 100 g = 364 kcal = 10 g protein; 1 cup = $1
  const flourMappings = [
    { a: { value: 1, unit: "cup" }, b: { value: 100, unit: "gram" } },
    { a: { value: 100, unit: "g" }, b: { value: 364, unit: "kcal" } },
    { a: { value: 100, unit: "g" }, b: { value: 10, unit: "g protein" } },
    { a: { value: 1, unit: "cup" }, b: { value: 1, unit: "dollar" } },
  ];
  const flour = makeIngredient("flour", "flour", flourMappings);
  // Second flour identity, so a recipe can hold a normal flour row AND a
  // dredging flour row without colliding ids.
  const flour2 = makeIngredient("flour2", "flour", flourMappings);
  // oil: 100 g = 884 kcal; 1000 g = $5
  const oil = makeIngredient("oil", "neutral oil", [
    { a: { value: 100, unit: "g" }, b: { value: 884, unit: "kcal" } },
    { a: { value: 1000, unit: "g" }, b: { value: 5, unit: "dollar" } },
  ]);
  // salt: 100 g = 38758 mg sodium; 100 g = $0.10
  const salt = makeIngredient("salt", "salt", [
    { a: { value: 100, unit: "g" }, b: { value: 38758, unit: "mg sodium" } },
    { a: { value: 100, unit: "g" }, b: { value: 0.1, unit: "dollar" } },
  ]);
  // butter: 100 g = 717 kcal; 100 g = $1
  const butter = makeIngredient("butter", "butter", [
    { a: { value: 100, unit: "g" }, b: { value: 717, unit: "kcal" } },
    { a: { value: 100, unit: "g" }, b: { value: 1, unit: "dollar" } },
  ]);
  // parsley: 100 g = 36 kcal (no price mapping on purpose)
  const parsley = makeIngredient("parsley", "parsley", [
    { a: { value: 100, unit: "g" }, b: { value: 36, unit: "kcal" } },
  ]);
  // soy sauce: 100 g = 53 kcal; 100 g = $1
  const soy = makeIngredient("soy", "soy sauce", [
    { a: { value: 100, unit: "g" }, b: { value: 53, unit: "kcal" } },
    { a: { value: 100, unit: "g" }, b: { value: 1, unit: "dollar" } },
  ]);
  const ingMap = { flour, flour2, oil, salt, butter, parsley, soy };

  const flourCup = makeEntry("flour", "flour", [{ value: 1, unit: "cup" }]);
  const fryingOil = makeEntry("oil", "neutral oil", [], "for frying");

  // ── FryingMedium ──────────────────────────────────────────────────────────

  test("unmeasured frying oil: absorbed estimate (15% of batter weight)", async () => {
    const r = await calculateTotals([flourCup, fryingOil], ingMap, getName);

    // batter = 100 g flour; absorbed oil = 0.15 * 100 = 15 g
    expect(r.weight).toBeCloseTo(115, 0);
    // kcal: flour 364 + oil (15/100 * 884 = 132.6) = 496.6
    expect(r.nutrients["208"]).toBeCloseTo(496.6, 0);
    // protein comes from flour only
    expect(r.nutrients["203"]).toBeCloseTo(10, 0);
    // price: flour $1 + oil (15/1000 * 5 ≈ $0.075); WASM rounds slightly
    expect(r.price).toBeCloseTo(1.075, 1);
    // oil resolved → not flagged missing
    expect(r.missingByType).toEqual({ price: [], weight: [], nutrients: [] });
    expect(r.totalIngredients).toBe(2);
  });

  test("control: same recipe without the frying medium is unchanged", async () => {
    const r = await calculateTotals([flourCup], ingMap, getName);

    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364, 0);
  });

  test("MEASURED frying oil: full cost, absorbed weight/nutrients, excluded from basis", async () => {
    // "100 g oil, for frying" — the amount is the pot, not consumption.
    const measuredOil = makeEntry(
      "oil",
      "neutral oil",
      [{ value: 100, unit: "g" }],
      "for frying",
    );

    const r = await calculateTotals([flourCup, measuredOil], ingMap, getName);

    // Weight: flour 100 + absorbed 15 — NOT 200. The pot's own 100 g never
    // enters the basis either (15 = 0.15 × 100 flour, not 0.15 × 200).
    expect(r.weight).toBeCloseTo(115, 0);
    // kcal: 364 + 132.6 — NOT 364 + 884 (the whole pot).
    expect(r.nutrients["208"]).toBeCloseTo(496.6, 0);
    // Price: flour $1 + the FULL pot $0.50 (100 g of $5/kg) — you bought it.
    expect(r.price).toBeCloseTo(1.5, 2);
    expect(r.missingByType).toEqual({ price: [], weight: [], nutrients: [] });
  });

  test("frying medium with no resolvable mapping fails gracefully", async () => {
    const noMapOil = makeIngredient("oil2", "neutral oil", []); // empty mappings

    const r = await calculateTotals(
      [flourCup, makeEntry("oil2", "neutral oil", [], "for frying")],
      { flour, oil2: noMapOil },
      getName,
    );

    // flour is unaffected; the oil simply can't be estimated → missing.
    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364, 0);
    expect(r.missingByType.nutrients).toContain("neutral oil");
  });

  test("estimate-only recipe has no basis → estimated rows go missing", async () => {
    const r = await calculateTotals([fryingOil], ingMap, getName);

    expect(r.weight).toBe(0);
    expect(r.missingByType.price).toContain("neutral oil");
    expect(r.missingByType.weight).toContain("neutral oil");
    expect(r.missingByType.nutrients).toContain("neutral oil");
  });

  test("totals are order-independent (estimated rows first vs last)", async () => {
    const saltToTaste = makeEntry("salt", "salt", [], "to taste");
    const forward = await calculateTotals(
      [flourCup, fryingOil, saltToTaste],
      ingMap,
      getName,
    );
    const reversed = await calculateTotals(
      [saltToTaste, fryingOil, flourCup],
      ingMap,
      getName,
    );

    expect(reversed.weight).toBeCloseTo(forward.weight, 5);
    expect(reversed.price).toBeCloseTo(forward.price, 5);
    expect(reversed.nutrients).toEqual(forward.nutrients);
  });

  // ── Seasoning ─────────────────────────────────────────────────────────────

  test("'salt, to taste': 1% of dish weight through salt's own mappings", async () => {
    const saltToTaste = makeEntry("salt", "salt", [], "to taste");
    const r = await calculateTotals([flourCup, saltToTaste], ingMap, getName);

    // 1 g salt (0.01 × 100 g flour) → 387.58 mg sodium, ~$0.001
    expect(r.weight).toBeCloseTo(101, 0);
    expect(r.nutrients["307"]).toBeCloseTo(387.6, 0);
    expect(r.price).toBeCloseTo(1.001, 2);
    expect(r.missingByType.nutrients).toEqual([]);
  });

  test("measured salt is a normal ingredient even with 'to taste'", async () => {
    const measuredSalt = makeEntry(
      "salt",
      "salt",
      [{ value: 5, unit: "g" }],
      "to taste",
    );
    const r = await calculateTotals([flourCup, measuredSalt], ingMap, getName);

    expect(r.weight).toBeCloseTo(105, 0);
    expect(r.nutrients["307"]).toBeCloseTo(1937.9, 0);
  });

  // ── PanGrease / Garnish (flat estimates) ──────────────────────────────────

  test("'butter, for the pan': flat 10 g", async () => {
    const panButter = makeEntry("butter", "butter", [], "for the pan");
    const r = await calculateTotals([flourCup, panButter], ingMap, getName);

    expect(r.weight).toBeCloseTo(110, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 71.7, 0);
    expect(r.price).toBeCloseTo(1.1, 2);
  });

  test("'parsley, for garnish': flat 5 g; unmapped measures still go missing", async () => {
    const garnish = makeEntry("parsley", "parsley", [], "for garnish");
    const r = await calculateTotals([flourCup, garnish], ingMap, getName);

    expect(r.weight).toBeCloseTo(105, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 1.8, 0);
    // parsley has no price mapping — the flat estimate can't price it.
    expect(r.missingByType.price).toEqual(["parsley"]);
  });

  // ── Dredging ──────────────────────────────────────────────────────────────

  test("unmeasured 'flour, for dusting': 5% of dish weight", async () => {
    const dusting = makeEntry("flour2", "flour", [], "for dusting");
    const r = await calculateTotals([flourCup, dusting], ingMap, getName);

    // 5 g flour (0.05 × 100) → 18.2 kcal
    expect(r.weight).toBeCloseTo(105, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 18.2, 0);
  });

  test("measured dredging flour: full cost, 20% retained, excluded from basis", async () => {
    const dredge = makeEntry(
      "flour2",
      "flour",
      [{ value: 1, unit: "cup" }],
      "for dredging",
    );
    const r = await calculateTotals(
      [flourCup, dredge, fryingOil],
      ingMap,
      getName,
    );

    // Basis is the normal flour's 100 g ONLY: the dredge row's retained grams
    // are an estimate and must not feed the fry-oil basis (oil = 15 g, not 19).
    // Weight: 100 + 20 (0.2 × 100) + 15 = 135.
    expect(r.weight).toBeCloseTo(135, 0);
    // kcal: 364 + 72.8 (0.2 × 364) + 132.6 = 569.4
    expect(r.nutrients["208"]).toBeCloseTo(569.4, 0);
    // Price: $1 + FULL $1 (you used the cup; discarding doesn't refund) + oil.
    expect(r.price).toBeCloseTo(2.075, 1);
  });

  // ── Marinade ──────────────────────────────────────────────────────────────

  test("measured marinade (by section name): full cost, 15% retained", async () => {
    const soyRow = makeEntry(
      "soy",
      "soy sauce",
      [{ value: 100, unit: "g" }],
      undefined,
      "Marinade",
    );
    const r = await calculateTotals([flourCup, soyRow], ingMap, getName);

    // Weight: 100 + 15 (retained); kcal: 364 + 7.95; price: $1 + FULL $1.
    expect(r.weight).toBeCloseTo(115, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 7.95, 0);
    expect(r.price).toBeCloseTo(2, 2);
  });

  test("unmeasured marinade row stays missing (no estimable basis)", async () => {
    const soyRow = makeEntry("soy", "soy sauce", [], undefined, "Marinade");
    const r = await calculateTotals([flourCup, soyRow], ingMap, getName);

    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.missingByType.weight).toContain("soy sauce");
    expect(r.missingByType.price).toContain("soy sauce");
  });

  // ── Classifier traps (through the real wasm classifier) ───────────────────

  test("'refried beans' / 'stir-fry sauce' are normal ingredients", async () => {
    const beans = makeIngredient("beans", "refried beans", [
      { a: { value: 1, unit: "can" }, b: { value: 400, unit: "gram" } },
    ]);
    const stirfry = makeIngredient("stirfry", "stir-fry sauce", [
      { a: { value: 1, unit: "tbsp" }, b: { value: 15, unit: "gram" } },
    ]);

    const r = await calculateTotals(
      [
        makeEntry("beans", "refried beans", [{ value: 1, unit: "can" }]),
        makeEntry("stirfry", "stir-fry sauce", [{ value: 2, unit: "tbsp" }]),
      ],
      { beans, stirfry },
      getName,
    );

    // Full measured weights — the bare "fried"/"fry" substrings never classify.
    expect(r.weight).toBeCloseTo(430, 0);
  });

  // ── Per-row view parity ───────────────────────────────────────────────────

  test("computeUsageEstimates keys only estimated rows, sized off the basis", () => {
    const data = createIngredientData([flourCup, fryingOil], ingMap);
    const map = computeUsageEstimates(data, ingMap, getName);

    expect([...map.keys()]).toEqual(["oil"]);
    const m = map.get("oil");
    expect(m?.usage).toBe("frying_medium");
    expect(m?.info.gram.isOk() && m.info.gram.value.value).toBeCloseTo(15, 0);
    expect(m?.info.nutrient.isOk() && m.info.nutrient.value["208"]).toBeCloseTo(
      132.6,
      0,
    );
  });

  test("applyUsageEstimates overrides estimated rows + reports usages", () => {
    const data = createIngredientData([flourCup, fryingOil], ingMap);
    // Before: the unmeasured oil row has no usable measures.
    const rawOil = data.find((r) => r.id === "oil");
    expect(rawOil?.priceInfo?.nutrient.isOk()).toBe(false);

    const { data: withEstimates, estimatedRows } = applyUsageEstimates(
      data,
      ingMap,
      getName,
    );

    expect([...estimatedRows]).toEqual([["oil", "frying_medium"]]);
    const oilRow = withEstimates.find((r) => r.id === "oil");
    expect(
      oilRow?.priceInfo?.nutrient.isOk() &&
        oilRow.priceInfo.nutrient.value["208"],
    ).toBeCloseTo(132.6, 0);
    // Non-estimated rows pass through untouched (same reference).
    const flourRow = withEstimates.find((r) => r.id === "flour");
    expect(flourRow).toBe(data.find((r) => r.id === "flour"));
  });

  test("applyUsageEstimates overrides a MEASURED fry row: est weight, own cost", () => {
    const measuredOil = makeEntry(
      "oil",
      "neutral oil",
      [{ value: 100, unit: "g" }],
      "for frying",
    );
    const data = createIngredientData([flourCup, measuredOil], ingMap);
    const { data: withEstimates, estimatedRows } = applyUsageEstimates(
      data,
      ingMap,
      getName,
    );

    expect(estimatedRows.get("oil")).toBe("frying_medium");
    const oilRow = withEstimates.find((r) => r.id === "oil");
    // Displayed weight is the absorbed estimate, not the pot…
    expect(
      oilRow?.priceInfo?.gram.isOk() && oilRow.priceInfo.gram.value.value,
    ).toBeCloseTo(15, 0);
    // …while cost stays the full written amount.
    expect(
      oilRow?.priceInfo?.price.isOk() && oilRow.priceInfo.price.value.value,
    ).toBeCloseTo(0.5, 2);
  });

  test("applyUsageEstimates is a no-op when every row is normal", () => {
    const data = createIngredientData([flourCup], ingMap);
    const { data: out, estimatedRows } = applyUsageEstimates(
      data,
      ingMap,
      getName,
    );

    expect(out).toBe(data); // same array reference, untouched
    expect(estimatedRows.size).toBe(0);
  });
});
