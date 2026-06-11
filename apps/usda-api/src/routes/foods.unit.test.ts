import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hono } from "hono";
import type { USDADataSource } from "../data/types.js";
import { createFoodRoutes } from "./foods.js";

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
};

describe("Foods API routes", () => {
  let app: Hono;
  let dataSource: USDADataSource;

  beforeEach(() => {
    dataSource = {
      getCounts: vi.fn(),
      getFoodById: vi.fn(),
      findFoodByUpc: vi.fn(),
      findFoodByNdb: vi.fn(),
      findFoodsByLookupBatch: vi.fn(),
      listFoods: vi.fn(),
    };
    app = createFoodRoutes(dataSource);
  });

  describe("GET /api/foods/:fdc_id", () => {
    it("should return 400 for invalid fdc_id", async () => {
      const res = await app.request("/api/foods/invalid");
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json).toEqual({ error: "Invalid FDC ID" });
    });

    it("should return 404 when food not found", async () => {
      vi.mocked(dataSource.getFoodById).mockResolvedValueOnce(null);

      const res = await app.request("/api/foods/12345");
      expect(res.status).toBe(404);

      const json = await res.json();
      expect(json).toEqual({
        error: "Food not found",
        message: "No food found with FDC ID 12345",
      });
    });

    it("should return food data when found", async () => {
      vi.mocked(dataSource.getFoodById).mockResolvedValueOnce(mockFood);

      const res = await app.request("/api/foods/12345");
      expect(res.status).toBe(200);
      expect(dataSource.getFoodById).toHaveBeenCalledWith(12345);

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
      };

      vi.mocked(dataSource.findFoodByUpc).mockResolvedValueOnce(brandedFood);

      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "upc",
          gtin_upc: "123456789012",
        }),
      });

      expect(res.status).toBe(200);
      expect(dataSource.findFoodByUpc).toHaveBeenCalledWith("123456789012");

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
      };

      vi.mocked(dataSource.findFoodByNdb).mockResolvedValueOnce(legacyFood);

      const res = await app.request("/api/foods/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "ndb",
          ndb_number: 12345,
        }),
      });

      expect(res.status).toBe(200);
      expect(dataSource.findFoodByNdb).toHaveBeenCalledWith(12345);

      const json = await res.json();
      expect(json).toMatchObject({
        fdc_id: 12345,
        foodInfo: {
          description: "Apple, raw, legacy",
        },
      });
    });

    it("should return null when food not found", async () => {
      vi.mocked(dataSource.findFoodByUpc).mockResolvedValueOnce(null);

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
      vi.mocked(dataSource.findFoodsByLookupBatch).mockResolvedValueOnce([
        mockFood,
        null,
      ]);

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
  });
});
