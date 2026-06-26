import { describe, it, expect } from "vitest";
import {
  usdaContract,
  countsSchema,
  errorSchema,
  listFoodsQuery,
  listFoodsResponse,
  fdcIdParam,
  batchLookupBody,
  DEFAULT_LIST_FOODS_PAGE_INDEX,
  DEFAULT_LIST_FOODS_PAGE_SIZE,
  MAX_BATCH_LOOKUP_SIZE,
  MAX_LIST_FOODS_PAGE_SIZE,
} from "./index";

describe("USDA Contract", () => {
  describe("Contract structure", () => {
    it("should have all expected endpoints", () => {
      expect(usdaContract.counts).toBeDefined();
      expect(usdaContract.getFood).toBeDefined();
      expect(usdaContract.findByLookup).toBeDefined();
      expect(usdaContract.findByLookupBatch).toBeDefined();
      expect(usdaContract.listFoods).toBeDefined();
    });

    it("should have correct HTTP methods for endpoints", () => {
      expect(usdaContract.counts.method).toBe("GET");
      expect(usdaContract.getFood.method).toBe("GET");
      expect(usdaContract.findByLookup.method).toBe("POST");
      expect(usdaContract.findByLookupBatch.method).toBe("POST");
      expect(usdaContract.listFoods.method).toBe("GET");
    });

    it("should have correct paths for endpoints", () => {
      expect(usdaContract.counts.path).toBe("/counts");
      expect(usdaContract.getFood.path).toBe("/api/foods/:fdc_id");
      expect(usdaContract.findByLookup.path).toBe("/api/foods/search");
      expect(usdaContract.findByLookupBatch.path).toBe(
        "/api/foods/search/batch",
      );
      expect(usdaContract.listFoods.path).toBe("/api/foods");
    });
  });

  describe("Schema validation", () => {
    describe("countsSchema", () => {
      it("should accept valid counts object", () => {
        const validCounts = {
          usda_food: 100,
          usda_branded_food: 50,
          usda_nutrient: 200,
          usda_food_nutrient: 1000,
          usda_measure_unit: 25,
          usda_food_portion: 300,
          usda_sr_legacy_food: 75,
        };
        expect(() => countsSchema.parse(validCounts)).not.toThrow();
      });

      it("should reject negative counts", () => {
        const invalidCounts = {
          usda_food: -1,
          usda_branded_food: 50,
          usda_nutrient: 200,
          usda_food_nutrient: 1000,
          usda_measure_unit: 25,
          usda_food_portion: 300,
          usda_sr_legacy_food: 75,
        };
        expect(() => countsSchema.parse(invalidCounts)).toThrow();
      });

      it("should reject non-integer counts", () => {
        const invalidCounts = {
          usda_food: 1.5,
          usda_branded_food: 50,
          usda_nutrient: 200,
          usda_food_nutrient: 1000,
          usda_measure_unit: 25,
          usda_food_portion: 300,
          usda_sr_legacy_food: 75,
        };
        expect(() => countsSchema.parse(invalidCounts)).toThrow();
      });
    });

    describe("errorSchema", () => {
      it("should accept valid error object", () => {
        const validError = {
          error: "Not found",
          message: "Resource not found",
        };
        expect(() => errorSchema.parse(validError)).not.toThrow();
      });

      it("should accept error without optional message", () => {
        const validError = {
          error: "Bad request",
        };
        expect(() => errorSchema.parse(validError)).not.toThrow();
      });

      it("should reject error without error field", () => {
        const invalidError = {
          message: "Missing error field",
        };
        expect(() => errorSchema.parse(invalidError)).toThrow();
      });
    });

    describe("listFoodsQuery", () => {
      it("should accept valid query with all fields", () => {
        const validQuery = {
          nameFilter: "apple",
          dataTypeFilter: "branded_food" as const,
          orderBy: "description" as const,
          direction: "asc" as const,
          pageIndex: 0,
          pageSize: 10,
        };
        expect(() => listFoodsQuery.parse(validQuery)).not.toThrow();
      });

      it("should accept query with defaults", () => {
        const minimalQuery = {};
        const parsed = listFoodsQuery.parse(minimalQuery);
        expect(parsed.orderBy).toBe("description");
        expect(parsed.direction).toBe("asc");
        expect(parsed.pageIndex).toBe(DEFAULT_LIST_FOODS_PAGE_INDEX);
        expect(parsed.pageSize).toBe(DEFAULT_LIST_FOODS_PAGE_SIZE);
      });

      it("should coerce string numbers to numbers", () => {
        const queryWithStrings = {
          pageIndex: "5",
          pageSize: "20",
        };
        const parsed = listFoodsQuery.parse(queryWithStrings);
        expect(parsed.pageIndex).toBe(5);
        expect(parsed.pageSize).toBe(20);
      });

      it("should reject invalid orderBy values", () => {
        const invalidQuery = {
          orderBy: "invalid_field",
        };
        expect(() => listFoodsQuery.parse(invalidQuery)).toThrow();
      });

      it("should enforce hard pagination bounds", () => {
        expect(
          listFoodsQuery.parse({
            pageIndex: "0",
            pageSize: String(MAX_LIST_FOODS_PAGE_SIZE),
          }).pageSize,
        ).toBe(MAX_LIST_FOODS_PAGE_SIZE);

        expect(() => listFoodsQuery.parse({ pageIndex: "-1" })).toThrow();
        expect(() => listFoodsQuery.parse({ pageIndex: "1.5" })).toThrow();
        expect(() => listFoodsQuery.parse({ pageSize: "0" })).toThrow();
        expect(() =>
          listFoodsQuery.parse({
            pageSize: String(MAX_LIST_FOODS_PAGE_SIZE + 1),
          }),
        ).toThrow();
        expect(() => listFoodsQuery.parse({ pageSize: "1.5" })).toThrow();
      });

      it("accepts the relevance orderBy", () => {
        expect(listFoodsQuery.parse({ orderBy: "relevance" }).orderBy).toBe(
          "relevance",
        );
      });

      it("parses foodsOnly from a querystring without the coerce footgun", () => {
        // The bug being guarded: z.coerce.boolean() turned "false" into true.
        expect(listFoodsQuery.parse({ foodsOnly: "true" }).foodsOnly).toBe(
          true,
        );
        expect(listFoodsQuery.parse({ foodsOnly: "false" }).foodsOnly).toBe(
          false,
        );
        // And the web client's real boolean still works.
        expect(listFoodsQuery.parse({ foodsOnly: true }).foodsOnly).toBe(true);
        expect(listFoodsQuery.parse({}).foodsOnly).toBeUndefined();
      });
    });

    describe("fdcIdParam", () => {
      it("should accept valid fdc_id", () => {
        const validParam = { fdc_id: 12345 };
        expect(() => fdcIdParam.parse(validParam)).not.toThrow();
      });

      it("should coerce string to number", () => {
        const paramWithString = { fdc_id: "12345" };
        const parsed = fdcIdParam.parse(paramWithString);
        expect(parsed.fdc_id).toBe(12345);
      });

      it("should reject non-numeric fdc_id", () => {
        const invalidParam = { fdc_id: "not-a-number" };
        expect(() => fdcIdParam.parse(invalidParam)).toThrow();
      });
    });

    describe("batchLookupBody", () => {
      it("should enforce the max batch lookup size", () => {
        const lookups = Array.from(
          { length: MAX_BATCH_LOOKUP_SIZE },
          (_, i) => ({
            kind: "fdc" as const,
            fdc_id: i + 1,
          }),
        );

        expect(() => batchLookupBody.parse({ lookups })).not.toThrow();
        expect(() =>
          batchLookupBody.parse({
            lookups: [...lookups, { kind: "fdc", fdc_id: 999_999 }],
          }),
        ).toThrow();
      });
    });

    describe("listFoodsResponse", () => {
      it("should accept valid response", () => {
        const validResponse = {
          data: [
            {
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
            },
          ],
          count: 1,
        };
        expect(() => listFoodsResponse.parse(validResponse)).not.toThrow();
      });

      it("should reject response with non-array data", () => {
        const invalidResponse = {
          data: "not an array",
          count: 1,
        };
        expect(() => listFoodsResponse.parse(invalidResponse)).toThrow();
      });

      it("should reject response without count", () => {
        const invalidResponse = {
          data: [],
        };
        expect(() => listFoodsResponse.parse(invalidResponse)).toThrow();
      });
    });
  });
});
