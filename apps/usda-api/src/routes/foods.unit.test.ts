import {
  MAX_BATCH_LOOKUP_SIZE,
  MAX_LIST_FOODS_PAGE_SIZE,
} from "@cubby/usda-contract";
import type { FoodLookupParam, FoodSummary } from "@cubby/usda-schemas";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import type { ListFoodsArgs, ListFoodsResult } from "../data/types.js";
import { createFoodRoutes, type FoodRoutePort } from "./foods.js";

const mockFood = {
  fdc_id: 12345,
  brandedFoodInfo: null,
  foodInfo: {
    data_type: "foundation_food" as const,
    description: "Apple, raw",
  },
  legacyFoodInfo: null,
  nutritionInfo: {
    nutrientSummary: [],
    nutrientsPer100: {
      protein: 0.26,
      kcal: 52,
    },
  },
  portionInfoRaw: [],
} satisfies FoodSummary;

interface FoodRouteCalls {
  readonly foodIds: number[];
  readonly upcs: string[];
  readonly ndbNumbers: number[];
  readonly batches: FoodLookupParam[][];
  readonly lists: ListFoodsArgs[];
}

interface FoodRouteFake {
  readonly port: FoodRoutePort;
  readonly calls: FoodRouteCalls;
  readonly setFoodById: (fdcId: number, food: FoodSummary | null) => void;
  readonly setFoodByUpc: (upc: string, food: FoodSummary | null) => void;
  readonly setFoodByNdb: (ndbNumber: number, food: FoodSummary | null) => void;
  readonly setBatchResults: (foods: Array<FoodSummary | null>) => void;
  readonly setListResult: (result: ListFoodsResult) => void;
}

function createFoodRouteFake(): FoodRouteFake {
  const foodById = new Map<number, FoodSummary | null>();
  const foodByUpc = new Map<string, FoodSummary | null>();
  const foodByNdb = new Map<number, FoodSummary | null>();
  const calls: FoodRouteCalls = {
    foodIds: [],
    upcs: [],
    ndbNumbers: [],
    batches: [],
    lists: [],
  };
  let batchResults: Array<FoodSummary | null> = [];
  let listResult: ListFoodsResult = { data: [], count: 0 };

  return {
    port: {
      getFoodById: async (fdcId) => {
        calls.foodIds.push(fdcId);
        return foodById.get(fdcId) ?? null;
      },
      findFoodByUpc: async (upc) => {
        calls.upcs.push(upc);
        return foodByUpc.get(upc) ?? null;
      },
      findFoodByNdb: async (ndbNumber) => {
        calls.ndbNumbers.push(ndbNumber);
        return foodByNdb.get(ndbNumber) ?? null;
      },
      findFoodsByLookupBatch: async (lookups) => {
        calls.batches.push(lookups);
        return batchResults;
      },
      listFoods: async (args) => {
        calls.lists.push(args);
        return listResult;
      },
    },
    calls,
    setFoodById: (fdcId, food) => foodById.set(fdcId, food),
    setFoodByUpc: (upc, food) => foodByUpc.set(upc, food),
    setFoodByNdb: (ndbNumber, food) => foodByNdb.set(ndbNumber, food),
    setBatchResults: (foods) => {
      batchResults = foods;
    },
    setListResult: (result) => {
      listResult = result;
    },
  };
}

describe("Foods API routes", () => {
  let app: Hono;
  let dataSource: FoodRouteFake;

  beforeEach(() => {
    dataSource = createFoodRouteFake();
    app = createFoodRoutes(dataSource.port);
  });

  describe("GET /api/foods/:fdc_id", () => {
    it("should return 400 for invalid fdc_id", async () => {
      const res = await app.request("/api/foods/invalid");
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: "Invalid FDC ID" });
    });

    it("should return 404 when food not found", async () => {
      const res = await app.request("/api/foods/12345");
      expect(res.status).toBe(404);

      const json = await res.json();
      expect(json).toEqual({
        error: "Food not found",
        message: "No food found with FDC ID 12345",
      });
    });

    it("should return food data when found", async () => {
      dataSource.setFoodById(12345, mockFood);

      const res = await app.request("/api/foods/12345");
      expect(res.status).toBe(200);
      expect(dataSource.calls.foodIds).toEqual([12345]);

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: "Apple, raw",
          data_type: "foundation_food",
        },
      });
    });
  });

  describe("POST /api/foods/search", () => {
    it("should return 400 for invalid request body", async () => {
      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: "data" }),
      });

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: "Invalid lookup" });
    });

    it("should search by UPC and return food when found", async () => {
      const brandedFood = {
        ...mockFood,
        brandedFoodInfo: {
          brand_owner: "Coca Cola Company",
          brand_name: "Coca Cola",
          branded_food_category: "Soft Drinks",
          gtin_upc: "123456789012",
          ingredients: "Water, Sugar, etc",
          serving: {
            serving_size: 355,
            serving_size_unit: "ml",
            household_serving_fulltext: "1 can",
          },
        },
        foodInfo: {
          data_type: "branded_food" as const,
          description: "Coca Cola Original",
        },
      } satisfies FoodSummary;
      dataSource.setFoodByUpc("123456789012", brandedFood);

      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "upc",
          gtin_upc: "123456789012",
        }),
      });

      expect(res.status).toBe(200);
      expect(dataSource.calls.upcs).toEqual(["123456789012"]);

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: "Coca Cola Original",
        },
      });
    });

    it("should search by NDB and return food when found", async () => {
      const legacyFood = {
        ...mockFood,
        foodInfo: {
          data_type: "sr_legacy_food" as const,
          description: "Apple, raw, legacy",
        },
        legacyFoodInfo: {
          ndb_number: 12345,
        },
      } satisfies FoodSummary;
      dataSource.setFoodByNdb(12345, legacyFood);

      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "ndb",
          ndb_number: 12345,
        }),
      });

      expect(res.status).toBe(200);
      expect(dataSource.calls.ndbNumbers).toEqual([12345]);

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: "Apple, raw, legacy",
        },
      });
    });

    it("should return null when food not found", async () => {
      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "upc",
          gtin_upc: "000000000000",
        }),
      });

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toBeNull();
    });

    it("should handle malformed JSON gracefully", async () => {
      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json",
      });

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: "Invalid lookup" });
    });
  });

  describe("POST /api/foods/search/batch", () => {
    it("should preserve batch order and nulls", async () => {
      dataSource.setBatchResults([mockFood, null]);

      const res = await app.request("/api/foods/search/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lookups: [
            { kind: "upc", gtin_upc: "123456789012" },
            { kind: "ndb", ndb_number: 12345 },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        results: [expect.objectContaining({ fdc_id: 12345 }), null],
      });
    });

    it("should return 400 when the batch exceeds the lookup limit", async () => {
      const lookups = Array.from(
        { length: MAX_BATCH_LOOKUP_SIZE + 1 },
        (_, i) => ({
          kind: "fdc" as const,
          fdc_id: i + 1,
        }),
      );

      const res = await app.request("/api/foods/search/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookups }),
      });

      expect(res.status).toBe(400);
      expect(dataSource.calls.batches).toEqual([]);
      expect(await res.json()).toEqual({ error: "Invalid batch lookup" });
    });
  });

  describe("GET /api/foods", () => {
    it("should pass bounded pagination through to the data source", async () => {
      dataSource.setListResult({ data: [], count: 0 });

      const res = await app.request(
        `/api/foods?pageIndex=0&pageSize=${MAX_LIST_FOODS_PAGE_SIZE}`,
      );

      expect(res.status).toBe(200);
      expect(dataSource.calls.lists).toEqual([
        expect.objectContaining({
          pageIndex: 0,
          pageSize: MAX_LIST_FOODS_PAGE_SIZE,
        }),
      ]);
      expect(await res.json()).toEqual({ data: [], count: 0 });
    });

    it("should return 400 for out-of-bounds pagination", async () => {
      const res = await app.request(
        `/api/foods?pageIndex=0&pageSize=${MAX_LIST_FOODS_PAGE_SIZE + 1}`,
      );

      expect(res.status).toBe(400);
      expect(dataSource.calls.lists).toEqual([]);
      expect(await res.json()).toEqual({ error: "Invalid query parameters" });
    });
  });
});
