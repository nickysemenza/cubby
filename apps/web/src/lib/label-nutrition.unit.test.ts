import { testShortcode } from "@cubby/schemas/testing";
import type { FoodSummary } from "@cubby/usda-schemas";
import { describe, expect, it } from "vitest";

import {
  labelNutrientsPer100,
  labelNutritionMappings,
  productNutritionSource,
} from "~/lib/label-nutrition";
import { productWasmInputs } from "~/lib/unit-mapping-utils";

// Hero tortilla: a 44 g serving printing 80 kcal / 4 g protein on the label —
// the exact case named in the feature's motivation (a product USDA has no
// entry for, so the totals engine still needs a nutrition contribution).
const heroLabel = {
  servingGrams: 44,
  nutrients: { kcal: 80, protein: 4 },
  source: "Hero package label",
};

const productId = testShortcode("product", "PRD-TEST");

const brandedFood = (): FoodSummary => ({
  fdc_id: 123,
  legacyFoodInfo: null,
  foodInfo: { data_type: "branded_food", description: "SOME FOOD" },
  nutritionInfo: {
    nutrientSummary: [],
    nutrientsPer100: { "208": 900, "203": 20 },
  },
  portionInfoRaw: [{ amount: 1, modifier: "cup", gram_weight: 120 }],
  brandedFoodInfo: null,
});

describe("labelNutrientsPer100", () => {
  it("scales per-serving amounts to per-100 g, keyed by USDA nutrient code", () => {
    const per100 = labelNutrientsPer100(heroLabel);

    // 80 kcal / 44 g serving * 100 = ~181.8 kcal per 100 g.
    expect(per100["208"]).toBeCloseTo(181.818, 2);
    // 4 g protein / 44 g serving * 100 = ~9.09 g per 100 g.
    expect(per100["203"]).toBeCloseTo(9.091, 2);
    expect(Object.keys(per100)).toHaveLength(2);
  });

  it("omits keys the label didn't print", () => {
    const per100 = labelNutrientsPer100({
      servingGrams: 10,
      nutrients: { sodium: 5 },
      source: null,
    });

    expect(per100).toEqual({ "307": 50 });
  });
});

describe("labelNutritionMappings", () => {
  it("emits one 100 g = X <unit> edge per labelled nutrient, tagged to the product", () => {
    const mappings = labelNutritionMappings(productId, heroLabel);

    expect(mappings).toHaveLength(2);
    const kcalEdge = mappings.find((m) => m.b.unit === "kcal");
    expect(kcalEdge).toMatchObject({
      a: { value: 100, unit: "g" },
      b: { value: expect.closeTo(181.818, 2), unit: "kcal" },
      source: "label nutrition",
      sourceMetadata: { type: "product", productId },
    });
    const proteinEdge = mappings.find((m) => m.b.unit === "g protein");
    expect(proteinEdge).toMatchObject({
      a: { value: 100, unit: "g" },
      b: { value: expect.closeTo(9.091, 2), unit: "g protein" },
    });
  });

  it("skips a negative or non-finite label amount (mirrors the Rust nutrition_mappings guard)", () => {
    const mappings = labelNutritionMappings(productId, {
      servingGrams: 0,
      nutrients: { kcal: 80 },
      source: null,
    });

    // servingGrams 0 -> per100 = Infinity, which the guard drops.
    expect(mappings).toEqual([]);
  });
});

describe("productNutritionSource", () => {
  it("prefers label over USDA when both are present", () => {
    expect(
      productNutritionSource({
        labelNutrition: heroLabel,
        food: brandedFood(),
      }),
    ).toBe("label");
  });

  it("falls back to usda when there's no label", () => {
    expect(
      productNutritionSource({ labelNutrition: null, food: brandedFood() }),
    ).toBe("usda");
  });

  it("is none when neither is present", () => {
    expect(productNutritionSource({ labelNutrition: null, food: null })).toBe(
      "none",
    );
  });
});

describe("productWasmInputs precedence (label > fdc_id/USDA > none)", () => {
  it("label only: label edges present, food null", () => {
    const { unit_mappings, food } = productWasmInputs({
      id: productId,
      unitMappings: [],
      food: null,
      labelNutrition: heroLabel,
    });

    expect(food).toBeNull();
    expect(unit_mappings).toHaveLength(2);
    expect(unit_mappings.every((m) => m.source === "label nutrition")).toBe(
      true,
    );
  });

  it("fdc only: unchanged — USDA food input passes through untouched", () => {
    const stored = [
      { a: { value: 1, unit: "each" }, b: { value: 120, unit: "g" } },
    ];
    const { unit_mappings, food } = productWasmInputs({
      id: productId,
      unitMappings: stored,
      food: brandedFood(),
      labelNutrition: null,
    });

    expect(unit_mappings).toBe(stored);
    expect(food?.nutrients_per_100).toHaveLength(2);
    expect(food?.portions).toHaveLength(1);
  });

  it("both: label edges present, USDA nutrient edges dropped, portions kept", () => {
    const { unit_mappings, food } = productWasmInputs({
      id: productId,
      unitMappings: [],
      food: brandedFood(),
      labelNutrition: heroLabel,
    });

    expect(unit_mappings).toHaveLength(2);
    expect(unit_mappings.every((m) => m.source === "label nutrition")).toBe(
      true,
    );
    // The label wins outright — USDA's nutrient edges are dropped rather than
    // merged — but its portion/serving weight edges are still available.
    expect(food?.nutrients_per_100).toEqual([]);
    expect(food?.portions).toHaveLength(1);
  });

  it("none: unchanged — no label, no food", () => {
    const { unit_mappings, food } = productWasmInputs({
      id: productId,
      unitMappings: [],
      food: null,
      labelNutrition: null,
    });

    expect(unit_mappings).toEqual([]);
    expect(food).toBeNull();
  });
});
