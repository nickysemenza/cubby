import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  type ProductTopLevelOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import type {
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@cubby/usda-schemas";
import { describe, expect, it, vi } from "vitest";

import { USDAService, type USDAServiceClient } from "./usda.service";

/**
 * listLinkedProductFoods is private — exercised through the public
 * `listFoods(..., linkedProductsOnly | sort.orderBy === "linkedProducts")`
 * entry point, which forwards the full FoodSummaryWithLinkedProducts shape
 * (unlike listFoodSummaries, which strips linkedProducts/inferredUnitMappings).
 */

const makeFood = (
  fdc_id: number,
  description: string,
  data_type: DataType,
  gtin_upc: string,
): FoodSummary => ({
  fdc_id,
  foodInfo: { data_type, description },
  brandedFoodInfo: {
    brand_owner: null,
    brand_name: null,
    branded_food_category: null,
    gtin_upc,
    ingredients: null,
    serving: {
      serving_size: null,
      serving_size_unit: null,
      household_serving_fulltext: null,
    },
  },
  legacyFoodInfo: null,
  nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
  portionInfoRaw: [],
});

// fdc 101 "Apple Jam" / branded, 2 linked products
// fdc 102 "Banana Chips" / sr_legacy, 0 linked products
// fdc 103 "Cherry Pie" / branded, 1 linked product
// fdc 104 "Apple Pie" / foundation, 3 linked products
// fdc 105 "Raw Wheat" / agricultural (non-food type), 0 linked products
const FOODS = [
  makeFood(101, "Apple Jam", "branded_food", "000000000001"),
  makeFood(102, "Banana Chips", "sr_legacy_food", "000000000002"),
  makeFood(103, "Cherry Pie", "branded_food", "000000000003"),
  makeFood(104, "Apple Pie", "foundation_food", "000000000004"),
  makeFood(105, "Raw Wheat", "agricultural_acquisition", "000000000005"),
];

const LINKED_COUNTS_BY_UPC = new Map([
  ["000000000001", 2],
  ["000000000002", 0],
  ["000000000003", 1],
  ["000000000004", 3],
  ["000000000005", 0],
]);

const dummyProducts = (count: number): ProductTopLevelOut[] =>
  Array.from({ length: count }, (_, index) =>
    productTopLevelOut.parse({
      id: testShortcode("product", `PRD-USDA-${index}`),
      name: `Linked product ${index}`,
      aliases: [],
      tags: [],
      primaryGtin: null,
      fdc_id: null,
      growsPlantId: null,
      manufacturer: "Test",
      model: null,
      notes: null,
      labelNutrition: null,
      expectedQuantity: null,
      categoryId: null,
      category: null,
      images: [],
      labelImages: [],
      itemImageCount: 0,
      labelImageCount: 0,
      classificationEvidence: "",
      coverImageUrl: null,
      externalIds: [],
      price: null,
      pricing: {
        derivedPrice: null,
        effectivePrice: null,
        source: "none",
        knownExpenseCount: 0,
        unknownExpenseCount: 0,
        knownUnitCount: 0,
        partial: false,
      },
      usdaUnavailable: null,
      stockTracked: null,
      dataQuality: {
        status: "complete",
        facets: [],
        gaps: [],
        exceptions: [],
        relatedGaps: [],
        relatedExceptions: [],
      },
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    }),
  );

function makeService() {
  const usdaClient: USDAServiceClient = {
    findFood: vi.fn(async () => null),
    findFoodsBatch: vi.fn(async () => FOODS),
    getFoodSummaryByID: vi.fn(async () => null),
    listFoods: vi.fn(async () => ({ data: [], count: 0 })),
  };

  const getLinkedProducts = vi.fn(async (lookup?: FoodLookupParam) => {
    const upc = lookup?.kind === "upc" ? lookup.gtin_upc : undefined;
    return dummyProducts(upc ? (LINKED_COUNTS_BY_UPC.get(upc) ?? 0) : 0);
  });

  const getLinkedProductLookups = vi.fn(async () =>
    FOODS.map((f): FoodLookupParam => ({ kind: "fdc", fdc_id: f.fdc_id })),
  );

  return new USDAService(
    usdaClient,
    getLinkedProducts,
    getLinkedProductLookups,
  );
}

const sort = (
  orderBy: string,
  direction: "asc" | "desc" = "asc",
): SortParams => ({
  orderBy,
  direction,
});

const page = (pageIndex = 0, pageSize = 50): PaginationParams => ({
  pageIndex,
  pageSize,
});

describe("USDAService listLinkedProductFoods (via listFoods)", () => {
  it("loads linked products for a USDA page through one batch port call", async () => {
    const usdaClient: USDAServiceClient = {
      findFood: vi.fn(async () => null),
      findFoodsBatch: vi.fn(async () => []),
      getFoodSummaryByID: vi.fn(async () => null),
      listFoods: vi.fn(async () => ({ data: FOODS, count: FOODS.length })),
    };
    const getLinkedProducts = vi.fn(async () => dummyProducts(0));
    const getLinkedProductsBatch = vi.fn(async (lookups: FoodLookupParam[]) =>
      lookups.map((lookup) =>
        dummyProducts(
          lookup.kind === "upc"
            ? (LINKED_COUNTS_BY_UPC.get(lookup.gtin_upc) ?? 0)
            : 0,
        ),
      ),
    );
    const service = new USDAService(
      usdaClient,
      getLinkedProducts,
      undefined,
      getLinkedProductsBatch,
    );

    const result = await service.listFoods(
      undefined,
      undefined,
      sort("fdc_id"),
      page(),
    );

    expect(getLinkedProductsBatch).toHaveBeenCalledOnce();
    expect(getLinkedProductsBatch).toHaveBeenCalledWith(
      FOODS.map((food) => ({
        kind: "upc",
        gtin_upc: food.brandedFoodInfo?.gtin_upc,
      })),
    );
    expect(getLinkedProducts).not.toHaveBeenCalled();
    expect(result.data.map((food) => food.linkedProducts.length)).toEqual([
      2, 0, 1, 3, 0,
    ]);
  });

  it("filters by name (case-insensitive substring)", async () => {
    const service = makeService();
    const result = await service.listFoods(
      "apple",
      undefined,
      sort("fdc_id"),
      page(),
      undefined,
      undefined,
      true,
    );
    expect(result.count).toBe(2);
    expect(result.data.map((f) => f.foodInfo.description).sort()).toEqual([
      "Apple Jam",
      "Apple Pie",
    ]);
  });

  it("dataTypeFilter narrows regardless of foodsOnly", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      "branded_food",
      sort("fdc_id"),
      page(),
      true, // foodsOnly is irrelevant once dataTypeFilter is set
      undefined,
      true,
    );
    expect(result.data.map((f) => f.fdc_id).sort()).toEqual([101, 103]);
    expect(
      result.data.every((f) => f.foodInfo.data_type === "branded_food"),
    ).toBe(true);
  });

  it("a dataTypes set narrows regardless of foodsOnly, ignoring dataTypeFilter's single-type shape", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("fdc_id"),
      page(),
      true,
      ["sr_legacy_food", "foundation_food"],
      true,
    );
    expect(result.data.map((f) => f.fdc_id).sort()).toEqual([102, 104]);
  });

  it("foodsOnly alone drops non-food data types when no explicit type filter is set", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("fdc_id"),
      page(),
      true,
      undefined,
      true,
    );
    // fdc 105 is agricultural_acquisition — excluded; the other 4 (branded/
    // sr_legacy/foundation) all belong to FOOD_DATA_TYPES.
    expect(result.data.map((f) => f.fdc_id).sort((a, b) => a - b)).toEqual([
      101, 102, 103, 104,
    ]);
  });

  it("sorts by linkedProducts count ascending, tie-broken by description", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("linkedProducts", "asc"),
      page(0, 10),
      undefined,
      undefined,
      true,
    );
    // lengths: 101->2, 102->0, 103->1, 104->3, 105->0; 102/105 tie at 0 and
    // are broken by description ("Banana Chips" < "Raw Wheat").
    expect(result.data.map((f) => f.fdc_id)).toEqual([102, 105, 103, 101, 104]);
  });

  it("sorts by linkedProducts count descending — the description tie-break stays ascending, not flipped", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("linkedProducts", "desc"),
      page(0, 10),
      undefined,
      undefined,
      true,
    );
    expect(result.data.map((f) => f.fdc_id)).toEqual([104, 101, 103, 102, 105]);
  });

  it("sorts by data_type ascending, tie-broken by description", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("data_type", "asc"),
      page(0, 10),
      undefined,
      undefined,
      true,
    );
    // agricultural_acquisition < branded_food < foundation_food < sr_legacy_food;
    // the two branded_food entries (101 "Apple Jam", 103 "Cherry Pie") tie and
    // are broken alphabetically by description.
    expect(result.data.map((f) => f.fdc_id)).toEqual([105, 101, 103, 104, 102]);
  });

  it("sorts by fdc_id descending", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("fdc_id", "desc"),
      page(0, 10),
      undefined,
      undefined,
      true,
    );
    expect(result.data.map((f) => f.fdc_id)).toEqual([105, 104, 103, 102, 101]);
  });

  it("falls back to description sort for any other orderBy, honoring direction", async () => {
    const service = makeService();
    const asc = await service.listFoods(
      undefined,
      undefined,
      sort("name", "asc"),
      page(0, 10),
      undefined,
      undefined,
      true,
    );
    expect(asc.data.map((f) => f.foodInfo.description)).toEqual([
      "Apple Jam",
      "Apple Pie",
      "Banana Chips",
      "Cherry Pie",
      "Raw Wheat",
    ]);

    const desc = await service.listFoods(
      undefined,
      undefined,
      sort("name", "desc"),
      page(0, 10),
      undefined,
      undefined,
      true,
    );
    expect(desc.data.map((f) => f.foodInfo.description)).toEqual([
      "Raw Wheat",
      "Cherry Pie",
      "Banana Chips",
      "Apple Pie",
      "Apple Jam",
    ]);
  });

  it("paginates the sorted result", async () => {
    const service = makeService();
    const result = await service.listFoods(
      undefined,
      undefined,
      sort("fdc_id", "asc"),
      page(1, 2),
      undefined,
      undefined,
      true,
    );
    expect(result.count).toBe(5);
    expect(result.data.map((f) => f.fdc_id)).toEqual([103, 104]);
  });

  it("counts the full linked corpus but richly enriches only the selected page", async () => {
    const usdaClient: USDAServiceClient = {
      findFood: vi.fn(async () => null),
      findFoodsBatch: vi.fn(async () => FOODS),
      getFoodSummaryByID: vi.fn(async () => null),
      listFoods: vi.fn(async () => ({ data: [], count: 0 })),
    };
    const getLinkedProducts = vi.fn(async () => dummyProducts(0));
    const getLinkedProductsBatch = vi.fn(async (lookups: FoodLookupParam[]) =>
      lookups.map(() => dummyProducts(0)),
    );
    const countLinkedProducts = vi.fn(async (lookups: FoodLookupParam[]) =>
      lookups.map((lookup) =>
        lookup.kind === "upc"
          ? (LINKED_COUNTS_BY_UPC.get(lookup.gtin_upc) ?? 0)
          : 0,
      ),
    );
    const service = new USDAService(
      usdaClient,
      getLinkedProducts,
      async () =>
        FOODS.map((food): FoodLookupParam => ({
          kind: "fdc",
          fdc_id: food.fdc_id,
        })),
      getLinkedProductsBatch,
      countLinkedProducts,
    );

    const result = await service.listFoods(
      undefined,
      undefined,
      sort("linkedProducts", "desc"),
      page(1, 2),
      undefined,
      undefined,
      true,
    );

    expect(result.count).toBe(5);
    expect(result.data.map((food) => food.fdc_id)).toEqual([103, 102]);
    expect(countLinkedProducts).toHaveBeenCalledWith(
      FOODS.map((food) => ({
        kind: "upc",
        gtin_upc: food.brandedFoodInfo!.gtin_upc,
      })),
    );
    expect(getLinkedProductsBatch).toHaveBeenCalledWith([
      { kind: "upc", gtin_upc: "000000000003" },
      { kind: "upc", gtin_upc: "000000000002" },
    ]);
  });
});
