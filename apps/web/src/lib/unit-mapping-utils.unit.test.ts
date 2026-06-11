import { unsafeProductId } from "@cubby/schemas/identifiers";
import type { FoodSummary } from "@cubby/usda-schemas";
import { beforeAll, describe, expect, test } from "vitest";
import { convertAmountToPrice, safeConvertAmount } from "~/lib/recipe-costing";
import { ensureWasm } from "~/lib/wasm";
import {
  getAllUnitMappingsFromProduct,
  parseUnitMappingString,
} from "./unit-mapping-utils";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

describe("parseUnitMappingString", () => {
  test("parses conversion format with source", () => {
    const result = parseUnitMappingString("4 lb = $5 @ whole foods");
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.b.unit).toBe("$"); // Canonical form
    expect(result.source).toBe("whole foods");
  });

  test("parses conversion format without source", () => {
    const result = parseUnitMappingString("1 cup = 120g");
    expect(result.a.value).toBe(1);
    expect(result.a.unit).toBe("cup");
    expect(result.b.value).toBe(120);
    expect(result.b.unit).toBe("g");
    expect(result.source).toBeNull();
  });

  test("parses price-per format", () => {
    const result = parseUnitMappingString("$5/4lb");
    // Note: normalized order - amount first, then price
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.b.unit).toBe("$");
  });

  test("parses price-per format with source", () => {
    const result = parseUnitMappingString("$5/4lb @ costco");
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.source).toBe("costco");
  });

  test("parses decimal values", () => {
    const result = parseUnitMappingString("2.5 cups = $3.50");
    expect(result.a.value).toBe(2.5);
    expect(result.a.unit).toBe("cup"); // Singularized
    expect(result.b.value).toBe(3.5);
    expect(result.b.unit).toBe("$");
  });

  test("parses various unit formats", () => {
    const examples = [
      {
        input: "1 stick = 113g",
        expected: {
          a: { value: 1, unit: "stick" },
          b: { value: 113, unit: "g" },
        },
      },
      {
        input: "12 eggs = $7 @ store",
        expected: {
          a: { value: 12, unit: "egg" },
          b: { value: 7, unit: "$" },
          source: "store",
        },
      },
      {
        input: "2 lbs = $6",
        expected: { a: { value: 2, unit: "lb" }, b: { value: 6, unit: "$" } },
      },
    ];

    for (const { input, expected } of examples) {
      const result = parseUnitMappingString(input);
      expect(result.a.value).toBe(expected.a.value);
      expect(result.a.unit).toBe(expected.a.unit);
      expect(result.b.value).toBe(expected.b.value);
      expect(result.b.unit).toBe(expected.b.unit);
      if (expected.source) {
        expect(result.source).toBe(expected.source);
      }
    }
  });

  test("throws on invalid input", () => {
    expect(() => parseUnitMappingString("invalid")).toThrow();
    expect(() => parseUnitMappingString("4 lb")).toThrow();
    expect(() => parseUnitMappingString("")).toThrow();
  });
});

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
  id: unsafeProductId("prod-promix"),
  unitMappings: [],
  food: brandedFood(householdText),
  price: 39.99,
});

describe("createServingMapping bare-count guard (serving/whole conflation)", () => {
  // Regression: in the unit graph "whole" ≡ "each" ≡ the priced item, so a
  // household serving COUNT emitted as `whole` let one serving inherit the
  // per-item price (34 g of protein powder costed $61.38 — 1.5 "bags").

  test('"2 SCOOPS" emits the household word as the unit, not whole', () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));
    const serving = mappings.find((m) => m.source === "USDA FDC serving");

    expect(serving).toBeDefined();
    expect(serving?.a).toEqual({ value: 44.3, unit: "g" });
    expect(serving?.b.value).toBe(2);
    expect(serving?.b.unit).toBe("scoop"); // normalized, NOT "whole"
  });

  test("grams have no path to money (a scoop is not a purchasable item)", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));

    const fiftyGrams = convertAmountToPrice({ value: 50, unit: "g" }, mappings);
    // Pre-fix this resolved to ~$90.27 (50 g ÷ 22.15 g/serving × $39.99/each).
    expect(fiftyGrams.isErr()).toBe(true);
  });

  test("scoops still convert to grams (weight↔serving intact)", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));

    const grams = safeConvertAmount(
      { value: 1, unit: "scoop" },
      mappings,
      "weight",
    );
    expect(grams.isOk()).toBe(true);
    if (grams.isOk()) expect(grams.value.value).toBeCloseTo(22.15, 0);
  });

  test("bare-count recipe amounts still price via each", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("2 SCOOPS"));

    // "2 whole" (e.g. 2 bags) → 2 × $39.99. The each≡whole link must survive;
    // only the serving-metadata side is barred from emitting bare counts.
    const twoItems = convertAmountToPrice(
      { value: 2, unit: "whole" },
      mappings,
    );
    expect(twoItems.isOk()).toBe(true);
    if (twoItems.isOk()) expect(twoItems.value.value).toBeCloseTo(79.98, 2);
  });

  test("household text with a real unit is unchanged", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("0.5 cup"));
    const serving = mappings.find((m) => m.source === "USDA FDC serving");

    expect(serving?.b.unit).toBe("cup");
    expect(serving?.b.value).toBe(0.5);
  });
});
