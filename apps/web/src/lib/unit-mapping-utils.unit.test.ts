import { unsafeProductId } from "@cubby/schemas/identifiers";
import type { FoodSummary } from "@cubby/usda-schemas";
import { beforeAll, describe, expect, it } from "vitest";
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
  interface Case {
    name: string;
    input: string;
    expected: {
      a: { value: number; unit: string };
      b: { value: number; unit: string };
      // Only asserted when present (string or explicit null).
      source?: string | null;
    };
  }

  const CASES: Case[] = [
    {
      name: "conversion format with source",
      input: "4 lb = $5 @ whole foods",
      expected: {
        a: { value: 4, unit: "lb" },
        b: { value: 5, unit: "$" }, // canonical money form
        source: "whole foods",
      },
    },
    {
      name: "conversion format without source",
      input: "1 cup = 120g",
      expected: {
        a: { value: 1, unit: "cup" },
        b: { value: 120, unit: "g" },
        source: null,
      },
    },
    {
      // normalized order — amount first, then price
      name: "price-per format",
      input: "$5/4lb",
      expected: { a: { value: 4, unit: "lb" }, b: { value: 5, unit: "$" } },
    },
    {
      name: "price-per format with source",
      input: "$5/4lb @ costco",
      expected: {
        a: { value: 4, unit: "lb" },
        b: { value: 5, unit: "$" },
        source: "costco",
      },
    },
    {
      name: "decimal values (singularized unit)",
      input: "2.5 cups = $3.50",
      expected: {
        a: { value: 2.5, unit: "cup" },
        b: { value: 3.5, unit: "$" },
      },
    },
    {
      name: "named unit on the left",
      input: "1 stick = 113g",
      expected: {
        a: { value: 1, unit: "stick" },
        b: { value: 113, unit: "g" },
      },
    },
    {
      name: "plural count singularized, with source",
      input: "12 eggs = $7 @ store",
      expected: {
        a: { value: 12, unit: "egg" },
        b: { value: 7, unit: "$" },
        source: "store",
      },
    },
    {
      name: "plural weight singularized",
      input: "2 lbs = $6",
      expected: { a: { value: 2, unit: "lb" }, b: { value: 6, unit: "$" } },
    },
  ];

  it.each(CASES)("parses $name", ({ input, expected }) => {
    const result = parseUnitMappingString(input);
    expect(result.a.value).toBe(expected.a.value);
    expect(result.a.unit).toBe(expected.a.unit);
    expect(result.b.value).toBe(expected.b.value);
    expect(result.b.unit).toBe(expected.b.unit);
    if (expected.source !== undefined) {
      expect(result.source).toBe(expected.source);
    }
  });

  it.each(["invalid", "4 lb", ""])("throws on invalid input %j", (input) => {
    expect(() => parseUnitMappingString(input)).toThrow();
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
    if (twoItems.isOk()) expect(twoItems.value.value).toBeCloseTo(79.98, 2);
  });

  it("household text with a real unit is unchanged", () => {
    const mappings = getAllUnitMappingsFromProduct(promixProduct("0.5 cup"));
    const serving = mappings.find((m) => m.source === "USDA FDC serving");

    expect(serving?.b.unit).toBe("cup");
    expect(serving?.b.value).toBe(0.5);
  });
});
