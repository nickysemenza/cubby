import { countsSchema } from "@cubby/usda-contract";
import {
  foodSummary,
  type FoodLookupParam,
  type FoodSummary,
} from "@cubby/usda-schemas";
import type { D1Database } from "@cloudflare/workers-types";
import { toFtsQuery } from "../search/fts-query.js";
import {
  assertVersion,
  indexTableName,
  manifestKey,
  normalizeDataType,
  searchTableName,
} from "./artifact-layout.js";
import type { EdgeBindings } from "./cloudflare-types.js";
import type {
  Counts,
  ListFoodsArgs,
  ListFoodsResult,
  USDADataSource,
} from "./types.js";

const MAX_SQL_VARIABLES = 100;
const DEFAULT_CONCURRENCY = 16;

interface FoodIndexRow {
  fdc_id: number;
  data_type: string;
  description: string;
  gtin_upc: string | null;
  ndb_number: number | null;
  bundle_key: string;
  byte_offset: number;
  byte_length: number;
}

interface Manifest {
  counts: Counts;
}

interface VersionTables {
  version: string;
  foodIndex: string;
  foodSearch: string;
}

let activeVersionCache:
  | { promise: Promise<VersionTables>; loadedAt: number }
  | undefined;

function sanitizeVersion(version: string): VersionTables {
  assertVersion(version);
  return {
    version,
    foodIndex: indexTableName(version),
    foodSearch: searchTableName(version),
  };
}

async function getActiveVersion(db: D1Database): Promise<VersionTables> {
  const now = Date.now();
  if (activeVersionCache && now - activeVersionCache.loadedAt < 60_000) {
    return activeVersionCache.promise;
  }

  activeVersionCache = {
    loadedAt: now,
    promise: db
      .prepare("SELECT value FROM usda_edge_meta WHERE key = ?")
      .bind("active_version")
      .first<{ value: string }>()
      .then((row) => {
        if (!row?.value) {
          throw new Error("No active USDA edge dataset version configured");
        }
        return sanitizeVersion(row.value);
      })
      .catch((error) => {
        // Drop the entry so a transient failure isn't cached for the full TTL.
        activeVersionCache = undefined;
        throw error;
      }),
  };

  return activeVersionCache.promise;
}

function sqlOrderBy(orderBy: ListFoodsArgs["orderBy"]): string {
  switch (orderBy) {
    case "data_type":
      return "data_type";
    case "fdc_id":
      return "fdc_id";
    default:
      return "description";
  }
}

function sqlDirection(direction: ListFoodsArgs["direction"]): string {
  return direction === "desc" ? "DESC" : "ASC";
}

// The four user-facing food types. The other five (agricultural_acquisition,
// market_acquisition, sample_food, sub_sample_food, experimental_food) are the
// Foundation sampling pipeline + research records — provenance, not pickable
// foods — which USDA FDC itself doesn't surface in food search.
export const FOOD_DATA_TYPES = [
  "branded_food",
  "foundation_food",
  "sr_legacy_food",
  "survey_fndds_food",
] as const;

// Builds the data_type SQL predicate + bind values for a given column.
// Precedence: an explicit single `dataTypeFilter` wins, then a multi-type
// `dataTypes` list (comma-joined), then `foodsOnly` (the user-facing food
// types). Returns empty sql when none apply (all types).
export function dataTypePredicate(
  column: string,
  dataTypeFilter: string | undefined,
  foodsOnly: boolean | undefined,
  dataTypes?: string,
): { sql: string; values: string[] } {
  if (dataTypeFilter) return { sql: `${column} = ?`, values: [dataTypeFilter] };
  const multi = (dataTypes ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (multi.length > 0) {
    return {
      sql: `${column} IN (${multi.map(() => "?").join(", ")})`,
      values: multi,
    };
  }
  if (foodsOnly) {
    return {
      sql: `${column} IN (${FOOD_DATA_TYPES.map(() => "?").join(", ")})`,
      values: [...FOOD_DATA_TYPES],
    };
  }
  return { sql: "", values: [] };
}

// The seeded v20260611 artifacts predate build-time normalization and still
// contain the `market_acquistion` typo in R2 bundles, so this must run at
// read time until a re-seeded version is activated.
function normalizeFoodSummaryPayload(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === "object" &&
    "foodInfo" in payload &&
    payload.foodInfo &&
    typeof payload.foodInfo === "object" &&
    "data_type" in payload.foodInfo &&
    typeof payload.foodInfo.data_type === "string"
  ) {
    payload.foodInfo.data_type = normalizeDataType(payload.foodInfo.data_type);
  }
  if (
    payload &&
    typeof payload === "object" &&
    "brandedFoodInfo" in payload &&
    payload.brandedFoodInfo &&
    typeof payload.brandedFoodInfo === "object" &&
    "gtin_upc" in payload.brandedFoodInfo &&
    typeof payload.brandedFoodInfo.gtin_upc === "string"
  ) {
    payload.brandedFoodInfo.gtin_upc = normalizeUpc(
      payload.brandedFoodInfo.gtin_upc,
    );
  }
  return payload;
}

// USDA branded UPCs are sometimes stored with leading zeros stripped (e.g. an
// 11-digit value for a 12-digit UPC-A), which fails the >=12-char schema and
// 500s response validation. Left-pad short numeric UPCs to 12 — both fixing the
// crash and matching how products store UPCs for linking. Non-numeric or
// already-valid values pass through untouched.
export function normalizeUpc(upc: string): string {
  return /^\d{1,11}$/.test(upc) ? upc.padStart(12, "0") : upc;
}

function rowsFromResult<T>(result: { results?: T[]; success: boolean }): T[] {
  if (!result.success) {
    throw new Error("D1 query failed");
  }
  return result.results ?? [];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

export function createEdgeUsdaDataSource(
  env: EdgeBindings,
  options: { r2Concurrency?: number } = {},
): USDADataSource {
  const r2Concurrency = options.r2Concurrency ?? DEFAULT_CONCURRENCY;

  async function getPointerByFdcId(
    fdcId: number,
  ): Promise<FoodIndexRow | null> {
    const tables = await getActiveVersion(env.DB);
    return env.DB.prepare(`SELECT * FROM ${tables.foodIndex} WHERE fdc_id = ?`)
      .bind(fdcId)
      .first<FoodIndexRow>();
  }

  async function hydrate(
    row: FoodIndexRow | null,
  ): Promise<FoodSummary | null> {
    if (!row) return null;

    const object = await env.USDA_BUNDLES.get(row.bundle_key, {
      range: {
        offset: row.byte_offset,
        length: row.byte_length,
      },
    });
    if (!object) return null;

    const text = await object.text();
    // A single malformed record must not 500 the whole page: drop it (callers
    // filter nulls / treat null as not-found). This makes a page slightly
    // shorter than totalCount (the count is from the index, not hydrated rows) —
    // an acceptable trade for resilience against bad source data. Pointer
    // mismatch below still throws: that's index corruption, not data quality.
    let parsed: FoodSummary;
    try {
      parsed = foodSummary.parse(normalizeFoodSummaryPayload(JSON.parse(text)));
    } catch (err) {
      console.warn(`[hydrate] skipping unparseable food ${row.fdc_id}`, err);
      return null;
    }
    if (parsed.fdc_id !== row.fdc_id) {
      throw new Error(
        `R2 pointer mismatch for ${row.fdc_id}: read ${parsed.fdc_id}`,
      );
    }
    return parsed;
  }

  async function hydrateRows(rows: FoodIndexRow[]) {
    return mapWithConcurrency(rows, r2Concurrency, (row) => hydrate(row));
  }

  async function findByColumn(
    column: "gtin_upc" | "ndb_number",
    value: string | number,
  ): Promise<FoodSummary | null> {
    const tables = await getActiveVersion(env.DB);
    const row = await env.DB.prepare(
      `SELECT * FROM ${tables.foodIndex} WHERE ${column} = ? ORDER BY fdc_id ASC LIMIT 1`,
    )
      .bind(value)
      .first<FoodIndexRow>();
    return hydrate(row);
  }

  async function findRowsByColumn(
    column: "gtin_upc" | "ndb_number",
    values: Array<string | number>,
  ): Promise<Map<string | number, FoodIndexRow>> {
    const tables = await getActiveVersion(env.DB);
    const rows = new Map<string | number, FoodIndexRow>();

    for (let i = 0; i < values.length; i += MAX_SQL_VARIABLES) {
      const chunk = values.slice(i, i + MAX_SQL_VARIABLES);
      if (chunk.length === 0) continue;

      const placeholders = chunk.map(() => "?").join(", ");
      const result = await env.DB.prepare(
        `SELECT * FROM ${tables.foodIndex} WHERE ${column} IN (${placeholders}) ORDER BY ${column} ASC, fdc_id ASC`,
      )
        .bind(...chunk)
        .all<FoodIndexRow>();

      for (const row of rowsFromResult(result)) {
        const key = column === "gtin_upc" ? row.gtin_upc : row.ndb_number;
        if (key !== null && !rows.has(key)) rows.set(key, row);
      }
    }

    return rows;
  }

  return {
    async getCounts() {
      const tables = await getActiveVersion(env.DB);
      const key = manifestKey(tables.version);
      const object = await env.USDA_BUNDLES.get(key);
      if (!object) {
        throw new Error(`Missing USDA edge manifest: ${key}`);
      }
      const manifest = JSON.parse(await object.text()) as Manifest;
      return countsSchema.parse(manifest.counts);
    },

    async getFoodById(fdcId) {
      return hydrate(await getPointerByFdcId(fdcId));
    },

    findFoodByUpc(gtinUpc) {
      return findByColumn("gtin_upc", gtinUpc);
    },

    findFoodByNdb(ndbNumber) {
      return findByColumn("ndb_number", ndbNumber);
    },

    async findFoodsByLookupBatch(lookups: FoodLookupParam[]) {
      if (lookups.length === 0) return [];

      const upcs = Array.from(
        new Set(
          lookups
            .filter((lookup) => lookup.kind === "upc")
            .map((lookup) => lookup.gtin_upc),
        ),
      );
      const ndbNumbers = Array.from(
        new Set(
          lookups
            .filter((lookup) => lookup.kind === "ndb")
            .map((lookup) => lookup.ndb_number),
        ),
      );

      const [upcRows, ndbRows] = await Promise.all([
        findRowsByColumn("gtin_upc", upcs),
        findRowsByColumn("ndb_number", ndbNumbers),
      ]);

      const rows = lookups.map((lookup) =>
        lookup.kind === "upc"
          ? (upcRows.get(lookup.gtin_upc) ?? null)
          : (ndbRows.get(lookup.ndb_number) ?? null),
      );

      const uniqueRows = new Map<number, FoodIndexRow>();
      for (const row of rows) {
        if (row) uniqueRows.set(row.fdc_id, row);
      }
      const uniqueRowList = [...uniqueRows.values()];
      const hydrated = await hydrateRows(uniqueRowList);
      const hydratedById = new Map<number, FoodSummary | null>(
        uniqueRowList.map((row, i) => [row.fdc_id, hydrated[i] ?? null]),
      );

      return rows.map((row) =>
        row ? (hydratedById.get(row.fdc_id) ?? null) : null,
      );
    },

    async listFoods({
      nameFilter,
      dataTypeFilter,
      dataTypes,
      foodsOnly,
      orderBy = "description",
      direction = "asc",
      pageIndex = 0,
      pageSize = 10,
    }) {
      const tables = await getActiveVersion(env.DB);
      const offset = pageIndex * pageSize;
      const hasName = !!nameFilter && nameFilter.trim().length > 0;
      let dataFrom: string;
      let countFrom: string;
      let where: string;
      let values: string[];

      if (hasName) {
        dataFrom = `${tables.foodSearch}
             INNER JOIN ${tables.foodIndex} i
               ON i.fdc_id = ${tables.foodSearch}.fdc_id`;
        countFrom = tables.foodSearch;
        const dt = dataTypePredicate(
          `${tables.foodSearch}.data_type`,
          dataTypeFilter,
          foodsOnly,
          dataTypes,
        );
        where =
          `WHERE ${tables.foodSearch} MATCH ?` +
          (dt.sql ? ` AND ${dt.sql}` : "");
        values = [toFtsQuery(nameFilter), ...dt.values];
      } else {
        dataFrom = `${tables.foodIndex} i`;
        countFrom = `${tables.foodIndex} i`;
        const dt = dataTypePredicate(
          "i.data_type",
          dataTypeFilter,
          foodsOnly,
          dataTypes,
        );
        where = dt.sql ? `WHERE ${dt.sql}` : "";
        values = dt.values;
      }

      // Relevance ordering only means something with an FTS query: bm25 `rank`
      // (ascending = best match first), which lives on the FTS table. Without a
      // name filter, fall back to alphabetical so the option stays well-defined.
      const orderClause =
        orderBy === "relevance"
          ? hasName
            ? `${tables.foodSearch}.rank ASC`
            : "i.description ASC"
          : `i.${sqlOrderBy(orderBy)} ${sqlDirection(direction)}`;

      const result = await env.DB.prepare(
        `SELECT i.*
           FROM ${dataFrom}
           ${where}
           ORDER BY ${orderClause}
           LIMIT ? OFFSET ?`,
      )
        .bind(...values, pageSize, offset)
        .all<FoodIndexRow>();
      const rows = rowsFromResult(result);

      const countRow = await env.DB.prepare(
        `SELECT count(*) as count FROM ${countFrom} ${where}`,
      )
        .bind(...values)
        .first<{ count: number }>();
      const totalCount = countRow?.count ?? 0;

      const data = (await hydrateRows(rows)).filter(
        (food): food is FoodSummary => food !== null,
      );
      return { data, count: totalCount } satisfies ListFoodsResult;
    },
  };
}
