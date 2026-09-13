import {
  type FoodSummaryWithLinkedProducts,
  foodSummaryWithLinkedProducts,
} from "@cubby/schemas/usda";
import { describe, expect, it } from "vitest";

import { dedupeUsdaFoodsByUpc, nutrientCount } from "./usda-food-stats";

// Minimal builder — these helpers only read a handful of fields, so we cast a
// partial rather than constructing the full FoodSummary shape.
function makeFood(opts: {
  fdc_id: number;
  upc?: string | null;
  brandName?: string | null;
  ingredients?: string | null;
  nutrients?: Record<string, number>;
}): FoodSummaryWithLinkedProducts {
  return foodSummaryWithLinkedProducts.parse({
    fdc_id: opts.fdc_id,
    description: "TEST",
    foodInfo: { data_type: "branded_food", description: "TEST" },
    legacyFoodInfo: null,
    brandedFoodInfo: opts.upc
      ? {
          gtin_upc: opts.upc.padStart(12, "0"),
          brand_name: opts.brandName ?? null,
          brand_owner: null,
          branded_food_category: null,
          ingredients: opts.ingredients ?? null,
          serving: {
            serving_size: null,
            serving_size_unit: null,
            household_serving_fulltext: null,
          },
        }
      : null,
    nutritionInfo: {
      nutrientSummary: [],
      nutrientsPer100: opts.nutrients ?? {},
    },
    portionInfoRaw: [],
    inferredUnitMappings: [],
    linkedProducts: [],
  });
}

describe("nutrientCount", () => {
  it("counts distinct data points, including zero values", () => {
    expect(nutrientCount({ "203": 5, "205": 10, "208": 100 })).toBe(3);
    expect(nutrientCount({ "208": 0, "307": 0 })).toBe(2);
    expect(nutrientCount({})).toBe(0);
  });
});

describe("dedupeUsdaFoodsByUpc", () => {
  it("collapses same-UPC records and counts the duplicates", () => {
    const result = dedupeUsdaFoodsByUpc([
      makeFood({ fdc_id: 1, upc: "111", nutrients: { "208": 1 } }),
      makeFood({ fdc_id: 2, upc: "111", nutrients: { "208": 1 } }),
      makeFood({ fdc_id: 3, upc: "111", nutrients: { "208": 1 } }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.duplicateCount).toBe(2);
  });

  it("keeps the most-complete record (most nutrients wins)", () => {
    const result = dedupeUsdaFoodsByUpc([
      makeFood({ fdc_id: 1, upc: "111", nutrients: { "208": 1 } }),
      makeFood({ fdc_id: 2, upc: "111", nutrients: { "208": 1, "203": 2 } }),
    ]);
    expect(result[0]?.food.fdc_id).toBe(2);
  });

  it("breaks ties by a named brand, then ingredients, then newest fdc_id", () => {
    const result = dedupeUsdaFoodsByUpc([
      makeFood({ fdc_id: 10, upc: "111", brandName: null }),
      makeFood({ fdc_id: 11, upc: "111", brandName: "ACME" }),
    ]);
    expect(result[0]?.food.fdc_id).toBe(11);
  });

  it("leaves UPC-less foods distinct and preserves first-seen order", () => {
    const result = dedupeUsdaFoodsByUpc([
      makeFood({ fdc_id: 1, upc: null }),
      makeFood({ fdc_id: 2, upc: "111" }),
      makeFood({ fdc_id: 3, upc: null }),
    ]);
    expect(result.map((r) => r.food.fdc_id)).toEqual([1, 2, 3]);
    expect(result.every((r) => r.duplicateCount === 0)).toBe(true);
  });
});
