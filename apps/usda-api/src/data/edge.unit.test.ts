import { describe, expect, it, vi } from "vitest";
import {
  createEdgeUsdaDataSource,
  dataTypePredicate,
  FOOD_DATA_TYPES,
  normalizeUpc,
} from "./edge";
import type { EdgeBindings } from "./cloudflare-types";

describe("normalizeUpc", () => {
  it("left-pads leading-zero-stripped UPCs to 12 digits", () => {
    expect(normalizeUpc("41512086489")).toBe("041512086489"); // 11 -> 12
    expect(normalizeUpc("2593002166")).toBe("002593002166"); // 10 -> 12
  });

  it("leaves valid UPC-A/EAN-13/GTIN-14 lengths untouched", () => {
    expect(normalizeUpc("002593002166")).toBe("002593002166"); // 12
    expect(normalizeUpc("0025293000988")).toBe("0025293000988"); // 13
    expect(normalizeUpc("00025293000988")).toBe("00025293000988"); // 14
  });

  it("passes non-numeric values through unchanged", () => {
    expect(normalizeUpc("")).toBe("");
    expect(normalizeUpc("ABC123")).toBe("ABC123");
  });
});

describe("dataTypePredicate", () => {
  it("returns an empty predicate when neither filter is set (all types)", () => {
    expect(dataTypePredicate("i.data_type", undefined, undefined)).toEqual({
      sql: "",
      values: [],
    });
  });

  it("filters to an explicit single type", () => {
    expect(dataTypePredicate("i.data_type", "branded_food", undefined)).toEqual(
      { sql: "i.data_type = ?", values: ["branded_food"] },
    );
  });

  it("restricts to the food types when foodsOnly is set", () => {
    const { sql, values } = dataTypePredicate("i.data_type", undefined, true);
    expect(values).toEqual([...FOOD_DATA_TYPES]);
    expect(sql).toBe(
      `i.data_type IN (${FOOD_DATA_TYPES.map(() => "?").join(", ")})`,
    );
  });

  it("lets an explicit single type win over foodsOnly", () => {
    expect(dataTypePredicate("i.data_type", "sub_sample_food", true)).toEqual({
      sql: "i.data_type = ?",
      values: ["sub_sample_food"],
    });
  });
});

function makeEnv(bindCounts: number[]): EdgeBindings {
  const db = {
    prepare(query: string) {
      let boundValues: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          boundValues = values;
          if (query.includes(" IN ")) {
            bindCounts.push(values.length);
          }
          return statement;
        },
        async first<T>() {
          if (query.includes("usda_edge_meta")) {
            return { value: "vtest" } as T;
          }
          return null;
        },
        async all<T>() {
          expect(boundValues.length).toBeLessThanOrEqual(100);
          return { success: true, results: [] as T[] };
        },
      };
      return statement;
    },
  };

  return {
    DB: db as unknown as EdgeBindings["DB"],
    USDA_BUNDLES: { get: vi.fn() } as unknown as EdgeBindings["USDA_BUNDLES"],
  };
}

describe("createEdgeUsdaDataSource", () => {
  it("chunks batch lookup D1 IN queries to the D1 bound parameter limit", async () => {
    const bindCounts: number[] = [];
    const dataSource = createEdgeUsdaDataSource(makeEnv(bindCounts));
    const lookups = Array.from({ length: 150 }, (_, index) => ({
      kind: "upc" as const,
      gtin_upc: String(index).padStart(12, "0"),
    }));

    await expect(
      dataSource.findFoodsByLookupBatch(lookups),
    ).resolves.toHaveLength(150);

    expect(bindCounts).toEqual([100, 50]);
  });

  it("drops a record that fails schema validation instead of 500ing the page", async () => {
    // gtin_upc "ABC" is non-numeric + <12 chars, so normalizeUpc can't fix it
    // and foodSummary.parse rejects it — exactly the kind of bad source data
    // that used to throw and surface as empty/"no results" for the whole query.
    const badFood = JSON.stringify({
      fdc_id: 1,
      foodInfo: { data_type: "branded_food", description: "BAD" },
      legacyFoodInfo: null,
      brandedFoodInfo: {
        brand_owner: null,
        brand_name: null,
        branded_food_category: null,
        gtin_upc: "ABC",
        ingredients: null,
        serving: {
          serving_size: null,
          serving_size_unit: null,
          household_serving_fulltext: null,
        },
      },
      nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
      portionInfoRaw: [],
    });
    const row = {
      fdc_id: 1,
      data_type: "branded_food",
      description: "BAD",
      gtin_upc: "ABC",
      ndb_number: null,
      bundle_key: "b",
      byte_offset: 0,
      byte_length: badFood.length,
    };
    const env = {
      DB: {
        prepare(query: string) {
          const stmt = {
            bind() {
              return stmt;
            },
            async first<T>() {
              if (query.includes("usda_edge_meta"))
                return { value: "vtest" } as T;
              if (query.includes("count(")) return { count: 1 } as T;
              return null;
            },
            async all<T>() {
              return { success: true, results: [row] as T[] };
            },
          };
          return stmt;
        },
      },
      USDA_BUNDLES: {
        get: async () => ({ text: async () => badFood }),
      },
    } as unknown as EdgeBindings;

    const dataSource = createEdgeUsdaDataSource(env);
    const result = await dataSource.listFoods({ pageIndex: 0, pageSize: 10 });

    expect(result.count).toBe(1); // count comes from the index, unaffected
    expect(result.data).toHaveLength(0); // bad row dropped, not a thrown 500
  });
});
