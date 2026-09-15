import { testShortcode } from "@cubby/schemas/testing";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { FoodSummary } from "@cubby/usda-schemas";
import { describe, expect, it } from "vitest";

import { convertAmountToPrice, safeConvertAmount } from "~/lib/recipe-costing";

import {
  getAllUnitMappingsFromProduct,
  servingBasisUnit,
  toWFoodInput,
  unitMappingsFromFood,
  usdaNutrientBasis,
} from "./unit-mapping-utils";

// Note: unit-mapping STRING parsing (the "4 lb = $5" formats) lives upstream in
// the `ingredient` crate; the dead TS wrapper that duplicated it here was removed.

// A branded food whose household serving text parses to a bare count + name
// (the ProMix shape, fdc 576208: "2 SCOOPS" → 2 ⟨whole⟩, name "SCOOPS").
const brandedFood = (householdText: string): FoodSummary => ({
  fdc_id: 576208,
  legacyFoodInfo: null,
  foodInfo: { data_type: "branded_food", description: "WHEY PROTEIN POWDER" },
  nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
  portionInfoRaw: [],
  brandedFoodInfo: {
    brand_owner: null,
    brand_name: null,
    branded_food_category: null,
    gtin_upc: "791083667692",
    ingredients: null,
    serving: {
      serving_size: 44.3,
      serving_size_unit: "g",
      household_serving_fulltext: householdText,
    },
  },
});

const promixProduct = (householdText: string) => ({
  id: testShortcode("product", "PRD-2345"),
  unitMappings: [],
  food: brandedFood(householdText),
  labelNutrition: null,
  price: 39.99,
});

describe("createServingMapping bare-count guard (serving/whole conflation)", () => {
  // Regression: in the unit graph "whole" ≡ "each" ≡ the priced item, so a
  // household serving COUNT emitted as `whole` let one serving inherit the
  // per-item price (34 g of protein powder costed $61.38 — 1.5 "bags").

  it('"2 SCOOPS" emits the household word as the unit, not whole', () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));
    const serving = mappings.find((m) => m.source === "USDA FDC serving");

    expect(serving).toBeDefined();
    expect(serving?.a).toEqual({ value: 44.3, unit: "g" });
    expect(serving?.b.value).toBe(2);
    expect(serving?.b.unit).toBe("scoop"); // normalized, NOT "whole"
  });

  it("grams have no path to money (a scoop is not a purchasable item)", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));

    const fiftyGrams = convertAmountToPrice({ value: 50, unit: "g" }, mappings);
    // Pre-fix this resolved to ~$90.27 (50 g ÷ 22.15 g/serving × $39.99/each).
    expect(fiftyGrams.isErr()).toBe(true);
  });

  it("scoops still convert to grams (weight↔serving intact)", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));

    const grams = safeConvertAmount(
      { value: 1, unit: "scoop" },
      mappings,
      "weight",
    );
    expect(grams.isOk()).toBe(true);
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (grams.isOk()) expect(grams.value.value).toBeCloseTo(22.15, 0);
  });

  it("bare-count recipe amounts still price via each", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));

    // "2 whole" (e.g. 2 bags) → 2 × $39.99. The each≡whole link must survive;
    // only the serving-metadata side is barred from emitting bare counts.
    const twoItems = convertAmountToPrice(
      { value: 2, unit: "whole" },
      mappings,
    );
    expect(twoItems.isOk()).toBe(true);
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (twoItems.isOk()) expect(twoItems.value.value).toBeCloseTo(79.98, 2);
  });

  it("household text with a real unit is unchanged", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("0.5 cup"));
    const serving = mappings.find((m) => m.source === "USDA FDC serving");

    expect(serving?.b.unit).toBe("cup");
    expect(serving?.b.value).toBe(0.5);
  });
});

describe("nutrition mapping inputs", () => {
  it("preserves an explicit zero nutrient reading", () => {
    const food: FoodSummary = {
      ...brandedFood("2 SCOOPS"),
      nutritionInfo: {
        nutrientSummary: [],
        nutrientsPer100: { "203": 0, "999": 0 },
      },
    };

    expect(toWFoodInput(food).nutrients_per_100).toEqual([
      { unit: "g protein", amount: 0 },
    ]);
  });
});

// A mL-serving branded food (the Fairlife 2% milk shape, fdc 2670155: 13 g
// protein / 240 mL -> 5.42 per 100, exactly the stored value). USDA reports
// nutrients per 100 mL for these, not per 100 g — see `nutrient_basis_unit`
// in food_mappings.rs.
const mlServingFood = (serving_size_unit: string | null): FoodSummary => ({
  fdc_id: 2670155,
  legacyFoodInfo: null,
  foodInfo: { data_type: "branded_food", description: "2% MILK" },
  nutritionInfo: {
    nutrientSummary: [],
    nutrientsPer100: { "203": 5.42 },
  },
  portionInfoRaw: [],
  brandedFoodInfo: {
    brand_owner: null,
    brand_name: null,
    branded_food_category: null,
    gtin_upc: "811620021448",
    ingredients: null,
    serving: {
      serving_size: 240,
      serving_size_unit,
      household_serving_fulltext: "1 cup",
    },
  },
});

describe("usdaNutrientBasis", () => {
  it("reads 'ml' off the synthesized mappings for an mL-serving branded food", () => {
    const mappings = unitMappingsFromFood(mlServingFood("MLT"));
    expect(usdaNutrientBasis(mappings)).toBe("ml");
  });

  it("defaults to 'g' for an ordinary gram-serving food", () => {
    const mappings = unitMappingsFromFood(mlServingFood("GM"));
    expect(usdaNutrientBasis(mappings)).toBe("g");
  });

  it("defaults to 'g' when no USDA nutrition edge is present", () => {
    const mappings: UnitMapping[] = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 5, unit: "dollar" },
        source: "manual",
        sourceMetadata: { type: "manual" },
      },
    ];
    expect(usdaNutrientBasis(mappings)).toBe("g");
  });
});

describe("servingBasisUnit", () => {
  it.each([
    ["MLT", "ml"],
    ["MC", "ml"],
    ["ml", "ml"],
    ["GM", "g"],
    ["GRM", "g"],
    ["g", "g"],
    [null, "g"],
  ] as const)("serving_size_unit %s -> %s", (unit, expected) => {
    expect(servingBasisUnit(mlServingFood(unit))).toBe(expected);
  });

  it("defaults to 'g' when there is no branded food info at all", () => {
    expect(servingBasisUnit(null)).toBe("g");
    expect(servingBasisUnit(undefined)).toBe("g");
  });
});
