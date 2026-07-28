import { describe, expect, it, vi } from "vitest";
import {
  createEdgeUsdaDataSource,
  dataTypePredicate,
  dataTypePriorityCase,
  escapeLike,
  FOOD_DATA_TYPES,
  matchQualityBindings,
  matchQualityCase,
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

  it("builds an IN clause from a comma-joined dataTypes list", () => {
    expect(
      dataTypePredicate(
        "i.data_type",
        undefined,
        true,
        "foundation_food,sr_legacy_food,survey_fndds_food",
      ),
    ).toEqual({
      sql: "i.data_type IN (?, ?, ?)",
      values: ["foundation_food", "sr_legacy_food", "survey_fndds_food"],
    });
  });

  it("lets the single type win over the dataTypes list, and ignores blanks", () => {
    expect(
      dataTypePredicate("i.data_type", "branded_food", undefined, "foo,bar"),
    ).toEqual({ sql: "i.data_type = ?", values: ["branded_food"] });
    expect(
      dataTypePredicate("i.data_type", undefined, undefined, " , "),
    ).toEqual({ sql: "", values: [] });
  });
});

describe("dataTypePriorityCase", () => {
  // Ranking order is load-bearing for the picker: richer reference foods must
  // out-rank sparse branded label data (median nutrient counts in FDC are
  // SR Legacy ~85 > Survey ~65 > Foundation ~30 > Branded ~14). Guard the
  // monotonic order so a future edit to DATA_TYPE_PRIORITY can't silently
  // invert it.
  it("orders the four food types SR Legacy < Survey < Foundation < Branded, others last", () => {
    const sql = dataTypePriorityCase("s.data_type");
    const rank = (dt: string) => {
      const m = sql.match(new RegExp(`WHEN '${dt}' THEN (\\d+)`));
      if (!m) throw new Error(`no WHEN for ${dt}`);
      return Number(m[1]);
    };
    expect(rank("sr_legacy_food")).toBeLessThan(rank("survey_fndds_food"));
    expect(rank("survey_fndds_food")).toBeLessThan(rank("foundation_food"));
    expect(rank("foundation_food")).toBeLessThan(rank("branded_food"));
    // Everything not spelled out (sampling/research records) sorts after all
    // four food types via the ELSE bucket.
    expect(sql).toMatch(/ELSE 99 END$/);
    expect(rank("branded_food")).toBeLessThan(99);
    expect(sql.startsWith("CASE s.data_type ")).toBe(true);
  });
});

describe("escapeLike", () => {
  it("backslash-escapes LIKE metacharacters so they match literally", () => {
    expect(escapeLike("50% milk")).toBe("50\\% milk");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves ordinary search terms untouched", () => {
    expect(escapeLike("vanilla bean")).toBe("vanilla bean");
  });
});

describe("matchQualityCase", () => {
  // Tier order is the "smart match" signal: exact beats a whole-word match beats
  // a bare prefix beats everything else, so a literal "VANILLA BEAN" outranks
  // the long noisy descriptions bm25 would otherwise float.
  it("scores exact < word < prefix < other", () => {
    const sql = matchQualityCase("i.description");
    const tiers = [...sql.matchAll(/THEN (\d+)/g)].map((m) => Number(m[1]));
    const other = Number(sql.match(/ELSE (\d+) END$/)?.[1]);
    expect(tiers).toEqual([0, 1, 2]);
    expect(other).toBe(3);
  });

  it("binds one value per placeholder, in SQL appearance order", () => {
    // Drift here is silent and ugly: SQLite binds positionally, so a mismatch
    // shifts every later parameter (LIMIT/OFFSET included) rather than erroring.
    const sql = matchQualityCase("i.description");
    expect((sql.match(/\?/g) ?? []).length).toBe(
      matchQualityBindings("butter").length,
    );
  });

  it("separates a whole-word match from a mere prefix", () => {
    // The bug this exists for: FTS matches `butter*`, so "Butterbur" (a Japanese
    // vegetable) tied with real butters on the prefix tier and then won on
    // description length — outranking "Butter, whipped, with salt" and ghee.
    const [, wordSpace, wordComma, prefix] = matchQualityBindings("butter");
    const like = (pattern: string, value: string) => {
      const re = new RegExp(
        `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`,
        "i",
      );
      return re.test(value);
    };
    const isWord = (d: string) =>
      like(wordSpace as string, d) || like(wordComma as string, d);

    expect(isWord("Butter, salted")).toBe(true);
    expect(isWord("Butter oil, anhydrous")).toBe(true);
    expect(isWord("Butter, whipped, with salt")).toBe(true);
    expect(isWord("Butterbur, canned")).toBe(false);
    expect(isWord("Butterbur, (fuki), raw")).toBe(false);
    // Butterbur still matches the looser prefix tier, so it is ranked, not lost.
    expect(like(prefix as string, "Butterbur, canned")).toBe(true);
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
    // The index-lookup phase now issues one D1 batch() for all chunk
    // statements; route each through its own `all()` so the per-chunk bound
    // parameter assertion still runs.
    async batch<T>(statements: Array<{ all(): Promise<T> }>) {
      return Promise.all(statements.map((s) => s.all()));
    },
  };

  return {
    DB: db as unknown as EdgeBindings["DB"],
    USDA_BUNDLES: { get: vi.fn() } as unknown as EdgeBindings["USDA_BUNDLES"],
  };
}

function validFoodText(fdcId: number): string {
  return JSON.stringify({
    fdc_id: fdcId,
    brandedFoodInfo: null,
    foodInfo: {
      data_type: "foundation_food",
      description: `Food ${fdcId}`,
    },
    legacyFoodInfo: null,
    nutritionInfo: {
      nutrientSummary: [],
      nutrientsPer100: {
        kcal: 52,
      },
    },
    portionInfoRaw: [],
  });
}

function indexRow(fdcId: number, bundleText = validFoodText(fdcId)) {
  return {
    fdc_id: fdcId,
    data_type: "foundation_food",
    description: `Food ${fdcId}`,
    gtin_upc: null,
    ndb_number: null,
    bundle_key: `bundle-${fdcId}`,
    byte_offset: 0,
    byte_length: bundleText.length,
  };
}

function makeBatchHydrationEnv({
  fdcId = 1,
  cachedRows = [],
  foodCacheReadError,
  foodCacheWriteError,
  bundleText = validFoodText(fdcId),
}: {
  fdcId?: number;
  cachedRows?: Array<{ fdc_id: number; data: string }>;
  foodCacheReadError?: Error;
  foodCacheWriteError?: Error;
  bundleText?: string;
}) {
  const row = indexRow(fdcId, bundleText);
  const r2Get = vi.fn(async () => ({ text: async () => bundleText }));
  const db = {
    prepare(query: string) {
      const statement = {
        query,
        bind() {
          return statement;
        },
        async first<T>() {
          if (query.includes("usda_edge_meta")) {
            return { value: "vtest" } as T;
          }
          return null;
        },
        async all<T>() {
          if (query.includes("food_cache")) {
            if (foodCacheReadError) throw foodCacheReadError;
            return { success: true, results: cachedRows as T[] };
          }
          if (query.includes("WHERE fdc_id IN")) {
            return { success: true, results: [row] as T[] };
          }
          return { success: true, results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
    async batch<T>(
      statements: Array<{
        query?: string;
        all(): Promise<T>;
        run(): Promise<T>;
      }>,
    ) {
      if (
        statements.some((statement) =>
          statement.query?.includes("INSERT OR IGNORE INTO food_cache"),
        )
      ) {
        if (foodCacheWriteError) throw foodCacheWriteError;
        return Promise.all(statements.map((statement) => statement.run()));
      }
      return Promise.all(statements.map((statement) => statement.all()));
    },
  };

  return {
    env: {
      DB: db as unknown as EdgeBindings["DB"],
      USDA_BUNDLES: { get: r2Get } as unknown as EdgeBindings["USDA_BUNDLES"],
    },
    r2Get,
  };
}

function makeListHydrationEnv({
  fdcId = 1,
  bundleText = validFoodText(fdcId),
}: {
  fdcId?: number;
  bundleText?: string;
}) {
  const row = indexRow(fdcId, bundleText);
  const r2Get = vi.fn(async () => ({ text: async () => bundleText }));
  const db = {
    prepare(query: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          if (query.includes("usda_edge_meta")) {
            return { value: "vtest" } as T;
          }
          if (query.includes("count(*)")) return { count: 1 } as T;
          return null;
        },
        async all<T>() {
          return { success: true, results: [row] as T[] };
        },
      };
      return statement;
    },
  };

  return {
    env: {
      DB: db as unknown as EdgeBindings["DB"],
      USDA_BUNDLES: { get: r2Get } as unknown as EdgeBindings["USDA_BUNDLES"],
    },
    r2Get,
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
    // listFoods receives the PARSED query (defaults applied), so orderBy/
    // direction are always present — mirror that here.
    const result = await dataSource.listFoods({
      pageIndex: 0,
      pageSize: 10,
      orderBy: "description",
      direction: "asc",
    });

    expect(result.count).toBe(1); // count comes from the index, unaffected
    expect(result.data).toHaveLength(0); // bad row dropped, not a thrown 500
  });

  it("treats unparseable resolved-food cache rows as misses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { env, r2Get } = makeBatchHydrationEnv({
        fdcId: 2,
        cachedRows: [{ fdc_id: 2, data: "not json" }],
      });
      const dataSource = createEdgeUsdaDataSource(env);

      const result = await dataSource.findFoodsByLookupBatch([
        { kind: "fdc", fdc_id: 2 },
      ]);

      expect(result[0]?.fdc_id).toBe(2);
      expect(r2Get).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("treats resolved-food cache read failures as misses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { env, r2Get } = makeBatchHydrationEnv({
        fdcId: 3,
        foodCacheReadError: new Error("cache read failed"),
      });
      const dataSource = createEdgeUsdaDataSource(env);

      const result = await dataSource.findFoodsByLookupBatch([
        { kind: "fdc", fdc_id: 3 },
      ]);

      expect(result[0]?.fdc_id).toBe(3);
      expect(r2Get).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not fail lookups when resolved-food cache writes fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { env, r2Get } = makeBatchHydrationEnv({
        fdcId: 4,
        foodCacheWriteError: new Error("cache write failed"),
      });
      const dataSource = createEdgeUsdaDataSource(env);

      const result = await dataSource.findFoodsByLookupBatch([
        { kind: "fdc", fdc_id: 4 },
      ]);

      expect(result[0]?.fdc_id).toBe(4);
      expect(r2Get).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("treats bundle Cache API read and write failures as R2 misses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("caches", {
      default: {
        match: async () => {
          throw new Error("cache read failed");
        },
        put: async () => {
          throw new Error("cache write failed");
        },
      },
    });

    try {
      const { env, r2Get } = makeListHydrationEnv({ fdcId: 5 });
      const dataSource = createEdgeUsdaDataSource(env);

      const result = await dataSource.listFoods({
        pageIndex: 0,
        pageSize: 10,
        orderBy: "description",
        direction: "asc",
      });

      expect(result.data[0]?.fdc_id).toBe(5);
      expect(result.count).toBe(1);
      expect(r2Get).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it("falls back to R2 when a cached bundle payload is unparseable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bundleText = validFoodText(6);
    vi.stubGlobal("caches", {
      default: {
        match: async () => new Response("not json"),
        put: vi.fn(),
      },
    });

    try {
      const { env, r2Get } = makeListHydrationEnv({ fdcId: 6, bundleText });
      const dataSource = createEdgeUsdaDataSource(env);

      const result = await dataSource.listFoods({
        pageIndex: 0,
        pageSize: 10,
        orderBy: "description",
        direction: "asc",
      });

      expect(result.data[0]?.fdc_id).toBe(6);
      expect(result.count).toBe(1);
      expect(r2Get).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it("serves getCounts from the Cache API on the second call (no second R2 read)", async () => {
    const counts = {
      usda_food: 5,
      usda_branded_food: 4,
      usda_nutrient: 3,
      usda_food_nutrient: 2,
      usda_measure_unit: 1,
      usda_food_portion: 6,
      usda_sr_legacy_food: 7,
    };
    const manifestText = JSON.stringify({ counts });
    let r2Reads = 0;
    const store = new Map<string, Response>();
    // Minimal colo Cache API stand-in (absent under Node by default).
    vi.stubGlobal("caches", {
      default: {
        match: async (req: Request) => store.get(req.url),
        put: async (req: Request, res: Response) => {
          store.set(req.url, res);
        },
      },
    });

    try {
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
                return null;
              },
            };
            return stmt;
          },
        },
        USDA_BUNDLES: {
          get: async () => {
            r2Reads += 1;
            return { text: async () => manifestText };
          },
        },
      } as unknown as EdgeBindings;

      const dataSource = createEdgeUsdaDataSource(env);
      expect(await dataSource.getCounts()).toEqual(counts);
      expect(r2Reads).toBe(1); // miss → one R2 read
      expect(await dataSource.getCounts()).toEqual(counts);
      expect(r2Reads).toBe(1); // hit → served from cache, no second R2 read
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Records every SQL string the data source prepares, so the ordering that
 * decides *which* row wins can be asserted.
 *
 * These are SQL-shape assertions, not runtime-ordering ones: this suite has no
 * real D1 (the fakes branch on `query.includes(...)`), so nothing here executes
 * ORDER BY. That's still the guard worth having — the failure mode being
 * prevented is someone reading `fdc_id DESC` as a typo and "fixing" it, which a
 * shape assertion catches and a mocked result set never would.
 */
function makeQueryRecordingEnv(): { env: EdgeBindings; queries: string[] } {
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          if (query.includes("usda_edge_meta")) return { value: "vtest" } as T;
          if (query.includes("count(*)")) return { count: 0 } as T;
          return null;
        },
        async all<T>() {
          return { success: true, results: [] as T[] };
        },
      };
      return statement;
    },
    async batch<T>(statements: Array<{ all(): Promise<T> }>) {
      return Promise.all(statements.map((s) => s.all()));
    },
  };
  return {
    env: {
      DB: db as unknown as EdgeBindings["DB"],
      USDA_BUNDLES: { get: vi.fn() } as unknown as EdgeBindings["USDA_BUNDLES"],
    },
    queries,
  };
}

describe("lookup resolves a barcode to its newest record", () => {
  // One barcode maps to several rows: FDC mints a new fdc_id every time a
  // branded item is republished. The lowest id is the oldest submission and is
  // routinely the one with no nutrients — resolving to it made the
  // `ingredient -> product -> fdc_id` hop land on an empty record.
  it("orders the single lookup by fdc_id DESC", async () => {
    const { env, queries } = makeQueryRecordingEnv();
    await createEdgeUsdaDataSource(env).findFoodByUpc("857750003948");

    const lookup = queries.find((q) => q.includes("WHERE gtin_upc = ?"));
    expect(lookup).toMatch(/ORDER BY fdc_id DESC LIMIT 1/);
    expect(lookup).not.toMatch(/fdc_id ASC/);
  });

  it("orders the NDB lookup by fdc_id DESC too", async () => {
    const { env, queries } = makeQueryRecordingEnv();
    await createEdgeUsdaDataSource(env).findFoodByNdb(1001);

    expect(queries.find((q) => q.includes("WHERE ndb_number = ?"))).toMatch(
      /ORDER BY fdc_id DESC LIMIT 1/,
    );
  });

  it("keeps the batch path in agreement with the single path", async () => {
    // `ORDER BY <column> ASC, fdc_id DESC` + the first-wins fold keeps the same
    // row the single lookup returns. If these two disagree, a product resolves
    // to a different food depending on which path enrichment happened to take.
    const { env, queries } = makeQueryRecordingEnv();
    await createEdgeUsdaDataSource(env).findFoodsByLookupBatch([
      { kind: "upc", gtin_upc: "857750003948" },
    ]);

    expect(queries.find((q) => q.includes("WHERE gtin_upc IN"))).toMatch(
      /ORDER BY gtin_upc ASC, fdc_id DESC/,
    );
  });
});

describe("relevance ordering", () => {
  it("ends with a unique key so paging is deterministic", async () => {
    // Tied rows otherwise come back in SQLite-defined order, which lets the
    // same row appear on two pages of a LIMIT/OFFSET scan, or on neither.
    const { env, queries } = makeQueryRecordingEnv();
    await createEdgeUsdaDataSource(env).listFoods({
      nameFilter: "butter",
      orderBy: "relevance",
      direction: "asc",
      pageIndex: 0,
      pageSize: 10,
    });

    const data = queries.find((q) => q.includes("ORDER BY CASE"));
    expect(data).toMatch(/rank ASC, i\.fdc_id ASC/);
  });
});
