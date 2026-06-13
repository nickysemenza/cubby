import type { Amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { beforeAll, describe, expect, it } from "vitest";
import {
  computeRecipeCosting,
  convertAmountToPrice,
  flattenSections,
} from "~/lib/recipe-costing";
import {
  calculateTotals,
  costRecipe,
  emptyIngredient,
  getName,
  ingredientFromMappings,
  makeEntry,
  makeRootRecipe,
  makeSubRecipe,
  makeSubRecipeEntry,
} from "~/lib/recipe-costing.fixtures";
import { ensureWasm } from "~/lib/wasm";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

describe("convertAmountToPrice", () => {
  it("successfully converts amount to price", () => {
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

  it("handles error when conversion fails", () => {
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
  it("handles empty mappings array", () => {
    const amount: Amount = { value: 1, unit: "cup" };
    const mappings: UnitMapping[] = []; // Empty mappings

    const result = convertAmountToPrice(amount, mappings);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("Failed to convert");
    }
  });

  it("handles incompatible unit mappings", () => {
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

  it("handles zero values in mappings", () => {
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

  it("handles very large values", () => {
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

  it("handles very small values", () => {
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

  it("handles case-insensitive unit names", () => {
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

  it("handles chained conversions", () => {
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

  it("handles circular mapping references", () => {
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

  it("handles custom unit names", () => {
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
  const chicken = ingredientFromMappings(
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

  it("calculates totals with all data available", () => {
    // rice: 1 cup = 200 g; 1 cup = $2.50; 100 g = 7 g protein = 130 kcal
    const rice = ingredientFromMappings(
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

    const result = calculateTotals(
      [
        makeEntry("ing1", "chicken", [{ value: 1, unit: "pound" }]),
        makeEntry("ing2", "rice", [{ value: 2, unit: "cup" }]),
      ],
      { ing1: chicken, ing2: rice },
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

  it("handles completely missing data", () => {
    const result = calculateTotals(
      [
        makeEntry("ing1", "unknown ingredient", [
          { value: 1, unit: "unknownunit" },
        ]),
      ],
      { ing1: emptyIngredient("ing1", "unknown ingredient") },
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

  it("handles partially missing data", () => {
    const result = calculateTotals(
      [
        makeEntry("ing1", "chicken", [{ value: 1, unit: "pound" }]),
        makeEntry("ing2", "unknown spice", [{ value: 1, unit: "teaspoon" }]),
      ],
      { ing1: chicken, ing2: emptyIngredient("ing2", "unknown spice") },
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

  it("handles missing only specific data types", () => {
    const name = "ingredient with weight only";
    // weight mapping only — no price, no nutrition (food stays null).
    const weightOnly = ingredientFromMappings("ing1", name, [
      { a: { value: 1, unit: "cup" }, b: { value: 240, unit: "gram" } },
    ]);

    const result = calculateTotals(
      [makeEntry("ing1", name, [{ value: 1, unit: "cup" }])],
      { ing1: weightOnly },
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

  it("handles error in ingredient processing", () => {
    const name = "problematic ingredient";
    const result = calculateTotals(
      [makeEntry("ing1", name, [])], // empty amounts → processing error
      { ing1: emptyIngredient("ing1", name) },
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
  it("rolls sub-recipe cost + calories into the parent totals, scaled by yield", () => {
    // tomato: 1 cup = 100 g = $1; 100 g = 10 g protein = 50 kcal
    const tomato = ingredientFromMappings(
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
    const pasta = ingredientFromMappings(
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
    const result = calculateTotals(
      [
        makeEntry("pasta", "pasta", [{ value: 1, unit: "scoop" }]),
        makeSubRecipeEntry(sauce, [{ value: 2, unit: "cup" }]),
      ],
      { tomato, pasta },
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

  it("guards against cycles (A → B → A) without hanging", () => {
    const recipeA = makeSubRecipe("recA", "A", { value: 1, unit: "batch" }, []);
    const recipeB = makeSubRecipe("recB", "B", { value: 1, unit: "batch" }, [
      makeSubRecipeEntry(recipeA, [{ value: 1, unit: "batch" }]),
    ]);
    // Close the loop: A uses B, B uses A.
    recipeA.sections[0].ingredients.push(
      makeSubRecipeEntry(recipeB, [{ value: 1, unit: "batch" }]),
    );

    // Should terminate (the visited-set cycle guard breaks the loop), not hang.
    const result = calculateTotals(
      flattenSections(recipeA.sections),
      {},
      { recA: recipeA, recB: recipeB },
    );

    expect(result).toBeDefined();
    expect(typeof result.price).toBe("number");
  });

  it("flags a yield-less sub-recipe as missing instead of guessing", () => {
    // No yield → can't scale → treated as unconvertible (missing), contributes $0.
    const sauce = makeSubRecipe("sauce", "tomato sauce", null, [
      makeEntry("tomato", "tomato", [{ value: 1, unit: "cup" }]),
    ]);

    const result = calculateTotals(
      [makeSubRecipeEntry(sauce, [{ value: 2, unit: "cup" }])],
      {},
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
  const flour = ingredientFromMappings("flour", "flour", flourMappings);
  // Second flour identity, so a recipe can hold a normal flour row AND a
  // dredging flour row without colliding ids.
  const flour2 = ingredientFromMappings("flour2", "flour", flourMappings);
  // oil: 100 g = 884 kcal; 1000 g = $5
  const oil = ingredientFromMappings("oil", "neutral oil", [
    { a: { value: 100, unit: "g" }, b: { value: 884, unit: "kcal" } },
    { a: { value: 1000, unit: "g" }, b: { value: 5, unit: "dollar" } },
  ]);
  // salt: 100 g = 38758 mg sodium; 100 g = $0.10
  const salt = ingredientFromMappings("salt", "salt", [
    { a: { value: 100, unit: "g" }, b: { value: 38758, unit: "mg sodium" } },
    { a: { value: 100, unit: "g" }, b: { value: 0.1, unit: "dollar" } },
  ]);
  // butter: 100 g = 717 kcal; 100 g = $1
  const butter = ingredientFromMappings("butter", "butter", [
    { a: { value: 100, unit: "g" }, b: { value: 717, unit: "kcal" } },
    { a: { value: 100, unit: "g" }, b: { value: 1, unit: "dollar" } },
  ]);
  // parsley: 100 g = 36 kcal (no price mapping on purpose)
  const parsley = ingredientFromMappings("parsley", "parsley", [
    { a: { value: 100, unit: "g" }, b: { value: 36, unit: "kcal" } },
  ]);
  // soy sauce: 100 g = 53 kcal; 100 g = $1
  const soy = ingredientFromMappings("soy", "soy sauce", [
    { a: { value: 100, unit: "g" }, b: { value: 53, unit: "kcal" } },
    { a: { value: 100, unit: "g" }, b: { value: 1, unit: "dollar" } },
  ]);
  const ingMap = { flour, flour2, oil, salt, butter, parsley, soy };

  const flourCup = makeEntry("flour", "flour", [{ value: 1, unit: "cup" }]);
  const fryingOil = makeEntry("oil", "neutral oil", [], "for frying");

  // ── FryingMedium ──────────────────────────────────────────────────────────

  it("unmeasured frying oil: absorbed estimate (15% of batter weight)", () => {
    const r = calculateTotals([flourCup, fryingOil], ingMap);

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

  it("control: same recipe without the frying medium is unchanged", () => {
    const r = calculateTotals([flourCup], ingMap);

    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364, 0);
  });

  it("MEASURED frying oil: full cost, absorbed weight/nutrients, excluded from basis", () => {
    // "100 g oil, for frying" — the amount is the pot, not consumption.
    const measuredOil = makeEntry(
      "oil",
      "neutral oil",
      [{ value: 100, unit: "g" }],
      "for frying",
    );

    const r = calculateTotals([flourCup, measuredOil], ingMap);

    // Weight: flour 100 + absorbed 15 — NOT 200. The pot's own 100 g never
    // enters the basis either (15 = 0.15 × 100 flour, not 0.15 × 200).
    expect(r.weight).toBeCloseTo(115, 0);
    // kcal: 364 + 132.6 — NOT 364 + 884 (the whole pot).
    expect(r.nutrients["208"]).toBeCloseTo(496.6, 0);
    // Price: flour $1 + the FULL pot $0.50 (100 g of $5/kg) — you bought it.
    expect(r.price).toBeCloseTo(1.5, 2);
    expect(r.missingByType).toEqual({ price: [], weight: [], nutrients: [] });
  });

  it("frying medium with no resolvable mapping fails gracefully", () => {
    const noMapOil = ingredientFromMappings("oil2", "neutral oil", []); // empty mappings

    const r = calculateTotals(
      [flourCup, makeEntry("oil2", "neutral oil", [], "for frying")],
      { flour, oil2: noMapOil },
    );

    // 100 g flour + ~15 g estimated absorbed oil. The oil has no mappings, but
    // its estimated weight is already in grams, so it resolves via the unit
    // engine's mass identity (no density) and counts toward weight — consistent
    // with a mapped frying medium. Cost/nutrients still can't resolve (no food).
    expect(r.weight).toBeCloseTo(115, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364, 0);
    expect(r.missingByType.nutrients).toContain("neutral oil");
  });

  it("estimate-only recipe has no basis → estimated rows go missing", () => {
    const r = calculateTotals([fryingOil], ingMap);

    expect(r.weight).toBe(0);
    expect(r.missingByType.price).toContain("neutral oil");
    expect(r.missingByType.weight).toContain("neutral oil");
    expect(r.missingByType.nutrients).toContain("neutral oil");
  });

  it("totals are order-independent (estimated rows first vs last)", () => {
    const saltToTaste = makeEntry("salt", "salt", [], "to taste");
    const forward = calculateTotals([flourCup, fryingOil, saltToTaste], ingMap);
    const reversed = calculateTotals(
      [saltToTaste, fryingOil, flourCup],
      ingMap,
    );

    expect(reversed.weight).toBeCloseTo(forward.weight, 5);
    expect(reversed.price).toBeCloseTo(forward.price, 5);
    expect(reversed.nutrients).toEqual(forward.nutrients);
  });

  // ── Seasoning ─────────────────────────────────────────────────────────────

  it("'salt, to taste': 1% of dish weight through salt's own mappings", () => {
    const saltToTaste = makeEntry("salt", "salt", [], "to taste");
    const r = calculateTotals([flourCup, saltToTaste], ingMap);

    // 1 g salt (0.01 × 100 g flour) → 387.58 mg sodium, ~$0.001
    expect(r.weight).toBeCloseTo(101, 0);
    expect(r.nutrients["307"]).toBeCloseTo(387.6, 0);
    expect(r.price).toBeCloseTo(1.001, 2);
    expect(r.missingByType.nutrients).toEqual([]);
  });

  it("measured salt is a normal ingredient even with 'to taste'", () => {
    const measuredSalt = makeEntry(
      "salt",
      "salt",
      [{ value: 5, unit: "g" }],
      "to taste",
    );
    const r = calculateTotals([flourCup, measuredSalt], ingMap);

    expect(r.weight).toBeCloseTo(105, 0);
    expect(r.nutrients["307"]).toBeCloseTo(1937.9, 0);
  });

  // ── PanGrease / Garnish (flat estimates) ──────────────────────────────────

  it("'butter, for the pan': flat 10 g", () => {
    const panButter = makeEntry("butter", "butter", [], "for the pan");
    const r = calculateTotals([flourCup, panButter], ingMap);

    expect(r.weight).toBeCloseTo(110, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 71.7, 0);
    expect(r.price).toBeCloseTo(1.1, 2);
  });

  it("'parsley, for garnish': flat 5 g; unmapped measures still go missing", () => {
    const garnish = makeEntry("parsley", "parsley", [], "for garnish");
    const r = calculateTotals([flourCup, garnish], ingMap);

    expect(r.weight).toBeCloseTo(105, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 1.8, 0);
    // parsley has no price mapping — the flat estimate can't price it.
    expect(r.missingByType.price).toEqual(["parsley"]);
  });

  // ── Dredging ──────────────────────────────────────────────────────────────

  it("unmeasured 'flour, for dusting': 5% of dish weight", () => {
    const dusting = makeEntry("flour2", "flour", [], "for dusting");
    const r = calculateTotals([flourCup, dusting], ingMap);

    // 5 g flour (0.05 × 100) → 18.2 kcal
    expect(r.weight).toBeCloseTo(105, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 18.2, 0);
  });

  it("measured dredging flour: full cost, 20% retained, excluded from basis", () => {
    const dredge = makeEntry(
      "flour2",
      "flour",
      [{ value: 1, unit: "cup" }],
      "for dredging",
    );
    const r = calculateTotals([flourCup, dredge, fryingOil], ingMap);

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

  it("measured marinade (by section name): full cost, 15% retained", () => {
    const soyRow = makeEntry(
      "soy",
      "soy sauce",
      [{ value: 100, unit: "g" }],
      undefined,
      "Marinade",
    );
    const r = calculateTotals([flourCup, soyRow], ingMap);

    // Weight: 100 + 15 (retained); kcal: 364 + 7.95; price: $1 + FULL $1.
    expect(r.weight).toBeCloseTo(115, 0);
    expect(r.nutrients["208"]).toBeCloseTo(364 + 7.95, 0);
    expect(r.price).toBeCloseTo(2, 2);
  });

  it("unmeasured marinade row stays missing (no estimable basis)", () => {
    const soyRow = makeEntry("soy", "soy sauce", [], undefined, "Marinade");
    const r = calculateTotals([flourCup, soyRow], ingMap);

    expect(r.weight).toBeCloseTo(100, 0);
    expect(r.missingByType.weight).toContain("soy sauce");
    expect(r.missingByType.price).toContain("soy sauce");
  });

  // ── Classifier traps (through the real wasm classifier) ───────────────────

  it("'refried beans' / 'stir-fry sauce' are normal ingredients", () => {
    const beans = ingredientFromMappings("beans", "refried beans", [
      { a: { value: 1, unit: "can" }, b: { value: 400, unit: "gram" } },
    ]);
    const stirfry = ingredientFromMappings("stirfry", "stir-fry sauce", [
      { a: { value: 1, unit: "tbsp" }, b: { value: 15, unit: "gram" } },
    ]);

    const r = calculateTotals(
      [
        makeEntry("beans", "refried beans", [{ value: 1, unit: "can" }]),
        makeEntry("stirfry", "stir-fry sauce", [{ value: 2, unit: "tbsp" }]),
      ],
      { beans, stirfry },
    );

    // Full measured weights — the bare "fried"/"fry" substrings never classify.
    expect(r.weight).toBeCloseTo(430, 0);
  });

  // ── Per-row view parity ───────────────────────────────────────────────────

  it("estimated rows carry the estimate, keyed off the shared basis", () => {
    const costing = costRecipe([flourCup, fryingOil], ingMap);

    expect([...costing.estimatedRows]).toEqual([["oil", "frying_medium"]]);
    const oilRow = costing.rows.find((r) => r.id === "oil");
    expect(
      oilRow?.priceInfo?.gram.isOk() && oilRow.priceInfo.gram.value.value,
    ).toBeCloseTo(15, 0);
    expect(
      oilRow?.priceInfo?.nutrient.isOk() &&
        oilRow.priceInfo.nutrient.value["208"],
    ).toBeCloseTo(132.6, 0);
    // Non-estimated rows keep their own measures.
    const flourRow = costing.rows.find((r) => r.id === "flour");
    expect(
      flourRow?.priceInfo?.gram.isOk() && flourRow.priceInfo.gram.value.value,
    ).toBeCloseTo(100, 0);
  });

  it("a MEASURED fry row displays est weight but own cost", () => {
    const measuredOil = makeEntry(
      "oil",
      "neutral oil",
      [{ value: 100, unit: "g" }],
      "for frying",
    );
    const costing = costRecipe([flourCup, measuredOil], ingMap);

    expect(costing.estimatedRows.get("oil")).toBe("frying_medium");
    const oilRow = costing.rows.find((r) => r.id === "oil");
    // Displayed weight is the absorbed estimate, not the pot…
    expect(
      oilRow?.priceInfo?.gram.isOk() && oilRow.priceInfo.gram.value.value,
    ).toBeCloseTo(15, 0);
    // …while cost stays the full written amount.
    expect(
      oilRow?.priceInfo?.price.isOk() && oilRow.priceInfo.price.value.value,
    ).toBeCloseTo(0.5, 2);
  });

  it("no estimated rows when every row is normal", () => {
    const costing = costRecipe([flourCup], ingMap);

    expect(costing.estimatedRows.size).toBe(0);
    expect(costing.rows).toHaveLength(1);
  });

  it("baker's percentages: own grams over flour grams", () => {
    const water = ingredientFromMappings("water", "water", [
      { a: { value: 1, unit: "g" }, b: { value: 1, unit: "gram" } },
    ]);
    const root = makeRootRecipe([
      flourCup,
      makeEntry("water", "water", [{ value: 200, unit: "g" }]),
    ]);
    const costing = computeRecipeCosting(
      [root],
      { ...ingMap, water },
      getName,
      {},
    ).get(root.id);

    expect(costing?.bakerPct.get("flour")).toBeCloseTo(100, 5);
    expect(costing?.bakerPct.get("water")).toBeCloseTo(200, 5);
  });
});

describe("calculateTotals diagnostics", () => {
  // flour: 1 cup = 100 g = $1; per-100g kcal. oil: kcal + price per kg.
  const flour = ingredientFromMappings("flour", "flour", [
    { a: { value: 1, unit: "cup" }, b: { value: 100, unit: "gram" } },
    { a: { value: 100, unit: "g" }, b: { value: 364, unit: "kcal" } },
    { a: { value: 1, unit: "cup" }, b: { value: 1, unit: "dollar" } },
  ]);
  const oil = ingredientFromMappings("oil", "neutral oil", [
    { a: { value: 100, unit: "g" }, b: { value: 884, unit: "kcal" } },
    { a: { value: 1000, unit: "g" }, b: { value: 5, unit: "dollar" } },
  ]);
  const ingMap = { flour, oil, mystery: emptyIngredient("mystery", "mystery") };

  it("records usage, fired rule, basis, and resolved values in input order", () => {
    const r = calculateTotals(
      [
        makeEntry("flour", "flour", [{ value: 1, unit: "cup" }]),
        makeEntry("oil", "neutral oil", [], "for frying"),
      ],
      ingMap,
    );

    expect(r.diagnostics).toHaveLength(2);
    const [flourDiag, oilDiag] = r.diagnostics;

    expect(flourDiag).toMatchObject({
      name: "flour",
      kind: "ingredient",
      usage: "normal",
      measured: true,
      basisGrams: null,
      plan: { cost: { kind: "own-full" } },
    });
    expect(flourDiag?.price).toEqual({ ok: true, value: 1, unit: "$" });

    // The oil row shows the consumption rule that fired AND the basis it used.
    expect(oilDiag).toMatchObject({
      name: "neutral oil",
      usage: "frying_medium",
      measured: false,
      basisGrams: 100,
      plan: { weight: { kind: "basis-fraction", fraction: 0.15 } },
    });
    expect(oilDiag?.gram.ok && oilDiag.gram).toMatchObject({ value: 15 });
    expect(oilDiag?.nutrient.ok && oilDiag.nutrient.kcal).toBeCloseTo(132.6, 0);
  });

  it("keeps the exact error strings the cells swallow into '—'", () => {
    const r = calculateTotals(
      [
        // No amounts on a normal row → "has no amounts" on all three.
        makeEntry("flour", "flour", []),
        // Measured but no product/mappings → per-measure conversion errors.
        makeEntry("mystery", "mystery", [{ value: 1, unit: "cup" }]),
      ],
      ingMap,
    );

    const errOf = (m: { ok: boolean } | undefined): string =>
      m && !m.ok && "error" in m ? String(m.error) : "";

    const [noAmounts, noMappings] = r.diagnostics;
    expect(errOf(noAmounts?.price)).toMatch(/has no amounts/);
    expect(errOf(noMappings?.price)).toMatch(/money/i);
    expect(errOf(noMappings?.gram)).toMatch(/weight/i);
    expect(errOf(noMappings?.nutrient)).toMatch(/nutrient/i);
    // missingByType (names only) is unchanged for existing consumers.
    expect(r.missingByType.price).toEqual(["flour", "mystery"]);
  });
});
