import { countsSchema } from "@cubby/usda-contract";
import {
  foodSummary,
  type FoodLookupParam,
  type FoodSummary,
} from "@cubby/usda-schemas";
import type { D1Database } from "@cloudflare/workers-types";
import { toFtsQuery } from "../search/fts-query.js";
import type { EdgeBindings } from "./cloudflare-types.js";
import type {
  Counts,
  ListFoodsArgs,
  ListFoodsResult,
  USDADataSource,
} from "./types.js";

const VERSION_RE = /^v[0-9A-Za-z_]+$/;
const MAX_SQL_VARIABLES = 100;
const DEFAULT_CONCURRENCY = 16;
const DATA_TYPE_ALIASES: Record<string, string> = {
  market_acquistion: "market_acquisition",
};

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
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid USDA edge dataset version: ${version}`);
  }
  return {
    version,
    foodIndex: `food_index_${version}`,
    foodSearch: `food_search_${version}`,
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

function sqlIndexOrderBy(orderBy: ListFoodsArgs["orderBy"]): string {
  return `i.${sqlOrderBy(orderBy)}`;
}

function sqlDirection(direction: ListFoodsArgs["direction"]): string {
  return direction === "desc" ? "DESC" : "ASC";
}

function normalizeDataType(dataType: string): string {
  return DATA_TYPE_ALIASES[dataType] ?? dataType;
}

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
  return payload;
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
    const parsed = foodSummary.parse(
      normalizeFoodSummaryPayload(JSON.parse(text)),
    );
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
      const manifestKey = `usda/${tables.version}/manifest.json`;
      const object = await env.USDA_BUNDLES.get(manifestKey);
      if (!object) {
        throw new Error(`Missing USDA edge manifest: ${manifestKey}`);
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
      const hydrated = await hydrateRows([...uniqueRows.values()]);
      const hydratedById = new Map<number, FoodSummary | null>();
      hydrated.forEach((food, i) => {
        const row = [...uniqueRows.values()][i]!;
        hydratedById.set(row.fdc_id, food);
      });

      return rows.map((row) =>
        row ? (hydratedById.get(row.fdc_id) ?? null) : null,
      );
    },

    async listFoods({
      nameFilter,
      dataTypeFilter,
      orderBy = "description",
      direction = "asc",
      pageIndex = 0,
      pageSize = 10,
    }) {
      const tables = await getActiveVersion(env.DB);
      const offset = pageIndex * pageSize;
      let rows: FoodIndexRow[];
      let totalCount: number;

      if (nameFilter && nameFilter.trim().length > 0) {
        const ftsQuery = toFtsQuery(nameFilter);
        const where = dataTypeFilter
          ? `WHERE ${tables.foodSearch} MATCH ? AND ${tables.foodSearch}.data_type = ?`
          : `WHERE ${tables.foodSearch} MATCH ?`;
        const values = dataTypeFilter ? [ftsQuery, dataTypeFilter] : [ftsQuery];

        const result = await env.DB.prepare(
          `SELECT i.*
             FROM ${tables.foodSearch}
             INNER JOIN ${tables.foodIndex} i
               ON i.fdc_id = ${tables.foodSearch}.fdc_id
             ${where}
             ORDER BY ${sqlIndexOrderBy(orderBy)} ${sqlDirection(direction)}
             LIMIT ? OFFSET ?`,
        )
          .bind(...values, pageSize, offset)
          .all<FoodIndexRow>();
        rows = rowsFromResult(result);

        const countRow = await env.DB.prepare(
          `SELECT count(*) as count FROM ${tables.foodSearch} ${where}`,
        )
          .bind(...values)
          .first<{ count: number }>();
        totalCount = countRow?.count ?? 0;
      } else {
        const where = dataTypeFilter ? "WHERE data_type = ?" : "";
        const values = dataTypeFilter ? [dataTypeFilter] : [];
        const result = await env.DB.prepare(
          `SELECT * FROM ${tables.foodIndex} ${where} ORDER BY ${sqlOrderBy(orderBy)} ${sqlDirection(direction)} LIMIT ? OFFSET ?`,
        )
          .bind(...values, pageSize, offset)
          .all<FoodIndexRow>();
        rows = rowsFromResult(result);

        const countRow = await env.DB.prepare(
          `SELECT count(*) as count FROM ${tables.foodIndex} ${where}`,
        )
          .bind(...values)
          .first<{ count: number }>();
        totalCount = countRow?.count ?? 0;
      }

      const data = (await hydrateRows(rows)).filter(
        (food): food is FoodSummary => food !== null,
      );
      return { data, count: totalCount } satisfies ListFoodsResult;
    },
  };
}
