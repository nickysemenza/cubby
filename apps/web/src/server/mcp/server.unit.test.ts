import { describe, expect, it } from "vitest";
import { createMcpServer, slimMeal, slimProduct, slimUsdaFood } from "./server";

describe("slimProduct USDA signal", () => {
  // Regression: get_product/list_products gave no USDA signal at all, so an
  // agent couldn't tell a product was linked. USDA resolves at query time
  // (UPC-first, ndb_number fallback) onto `food`; usdaFdcId is the canonical
  // "is it linked" flag and must reflect BOTH paths.

  it("surfaces usdaFdcId for a UPC-only link (ndb_number null)", () => {
    // e.g. Diamond Crystal salt: UPC resolves, ndb_number is null
    const slim = slimProduct({
      id: "p-1",
      name: "kosher salt",
      upc: "013600020019",
      ndb_number: null,
      food: { fdc_id: 2571981 },
    });
    expect(slim.usdaFdcId).toBe(2571981);
    expect(slim.ndb_number).toBeNull();
  });

  it("surfaces usdaFdcId for an ndb-only link (no UPC)", () => {
    // e.g. lard: no UPC, resolves via ndb_number
    const slim = slimProduct({
      id: "p-2",
      name: "lard",
      upc: null,
      ndb_number: 4002,
      food: { fdc_id: 999 },
    });
    expect(slim.usdaFdcId).toBe(999);
    expect(slim.ndb_number).toBe(4002);
  });

  it("reports null usdaFdcId when nothing resolved", () => {
    const slim = slimProduct({
      id: "p-3",
      name: "Bob's Red Mill flour",
      upc: "039978533012",
      ndb_number: null,
      food: null,
    });
    expect(slim.usdaFdcId).toBeNull();
  });

  it("does not conflate externalIds with USDA linkage", () => {
    const slim = slimProduct({
      id: "p-4",
      name: "widget",
      externalIds: [{ source: "amazon", externalId: "B000" }],
      food: null,
    });
    expect(slim.usdaFdcId).toBeNull();
    expect(slim.externalIds).toEqual([
      { source: "amazon", externalId: "B000" },
    ]);
  });
});

describe("slimMeal", () => {
  it("keeps meal essentials and summarizes each planned recipe", () => {
    const slim = slimMeal({
      id: "m-1",
      date: "2026-06-20",
      name: "Dinner",
      sortOrder: 0,
      totals: { costTotal: 12, caloriesTotal: 800, pending: false },
      // heavy nested recipe bodies should be dropped to a summary
      recipes: [
        {
          id: "mr-1",
          recipeId: "r-1",
          recipe: { id: "r-1", name: "Chili", sections: [{ huge: true }] },
          scale: 2,
          sortOrder: 0,
          scaledTotals: { costTotal: 12, caloriesTotal: 800 },
        },
      ],
    });
    // The per-recipe id is the mealRecipe id (for update/remove_meal_recipe).
    expect(slim.recipes).toEqual([
      {
        id: "mr-1",
        recipeId: "r-1",
        name: "Chili",
        scale: 2,
        scaledTotals: { costTotal: 12, caloriesTotal: 800 },
      },
    ]);
    expect(slim.date).toBe("2026-06-20");
  });

  it("tolerates a meal with no recipes", () => {
    const slim = slimMeal({
      id: "m-2",
      date: "2026-06-21",
      recipes: undefined,
    });
    expect(slim.recipes).toEqual([]);
  });
});

describe("slimUsdaFood", () => {
  it("surfaces id, description, link keys, and per-100g nutrients; drops portions", () => {
    const slim = slimUsdaFood({
      fdc_id: 2571981,
      foodInfo: { data_type: "branded_food", description: "Kosher salt" },
      brandedFoodInfo: {
        brand_owner: "Diamond Crystal",
        gtin_upc: "013600020019",
      },
      legacyFoodInfo: null,
      nutritionInfo: {
        nutrientsPer100: { Sodium: 39000 },
        nutrientSummary: [],
      },
      portionInfoRaw: [{ amount: 1, modifier: "tsp", gram_weight: 6 }],
      linkedProducts: [{ id: "p-1", name: "salt", notes: "drop me" }],
    });
    expect(slim).toEqual({
      fdc_id: 2571981,
      description: "Kosher salt",
      data_type: "branded_food",
      brand_owner: "Diamond Crystal",
      gtin_upc: "013600020019",
      ndb_number: null,
      nutrientsPer100: { Sodium: 39000 },
      linkedProducts: [{ id: "p-1", name: "salt" }],
    });
  });

  it("reads ndb_number from legacy foods with no brand", () => {
    const slim = slimUsdaFood({
      fdc_id: 4002,
      foodInfo: { data_type: "sr_legacy_food", description: "Lard" },
      brandedFoodInfo: null,
      legacyFoodInfo: { ndb_number: 4002 },
      nutritionInfo: { nutrientsPer100: {}, nutrientSummary: [] },
    });
    expect(slim.ndb_number).toBe(4002);
    expect(slim.gtin_upc).toBeNull();
  });
});

describe("createMcpServer registration", () => {
  // Smoke test: constructing the server registers every tool, which forces the
  // SDK to accept each tool's input shape (including the reused `.shape` spreads
  // for recipes/meals and the shared mcpPaginationParams). A bad shape throws here.
  it("registers all tools without throwing", () => {
    expect(() => createMcpServer()).not.toThrow();
  });
});
