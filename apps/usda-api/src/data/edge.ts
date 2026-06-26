import { countsSchema } from "@cubby/usda-contract";
import {
  DATA_TYPE_PRIORITY,
  foodSummary,
  type FoodLookupParam,
  type FoodSummary,
} from "@cubby/usda-schemas";
import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { type SpanAttr, withSpan } from "@cubby/worker-tracing";
import pMap from "p-map";
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
const DEFAULT_CONCURRENCY = 50;

type LookupColumn = "gtin_upc" | "ndb_number" | "fdc_id";

/** Aggregated R2/cache stats for one hydration pass, surfaced as span attrs. */
interface HydrateStats {
  cacheHits: number;
  r2Reads: number;
  bytesRead: number;
}

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

// SQL CASE that maps the `data_type` column to a richness/preference rank
// (lower = surfaced first), so a name search leads with the most data-complete
// reference foods (SR Legacy > Survey > Foundation) before sparse branded label
// data. Only the four food types are spelled out; everything else (the rare,
// near-empty sampling/research records) falls to the ELSE bucket — so the
// expression is robust to raw-value spelling quirks in those types. Priorities
// are bind-safe (integer literals from a trusted constant), data_type is a fixed
// column name, so this is not a SQL-injection surface.
export function dataTypePriorityCase(column: string): string {
  const whens = (
    [
      "sr_legacy_food",
      "survey_fndds_food",
      "foundation_food",
      "branded_food",
    ] as const
  )
    .map((dt) => `WHEN '${dt}' THEN ${DATA_TYPE_PRIORITY[dt]}`)
    .join(" ");
  return `CASE ${column} ${whens} ELSE 99 END`;
}

// Backslash-escapes the SQL LIKE metacharacters (`%`, `_`, `\`) in a raw search
// term so user punctuation can't act as a wildcard in the prefix match below.
// Pairs with `... LIKE ? ESCAPE '\\'`.
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// SQL CASE that scores how closely a row's description matches the raw search
// term (lower = surfaced first): exact (case-insensitive) beats prefix beats
// everything else. This is the "smart" tier that mimics USDA FDC's own search —
// it floats a literal "VANILLA BEAN" above noisy long descriptions like
// "VANILLA BEAN COCONUTMILK, VANILLA BEAN" that BM25 over-rewards because the
// query tokens repeat. Two `?` placeholders: the exact term, then the escaped
// `term%` prefix pattern. `column` is a fixed column name (not a bind surface).
export function matchQualityCase(column: string): string {
  return `CASE WHEN ${column} = ? COLLATE NOCASE THEN 0 WHEN ${column} LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END`;
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

// ── Resolved-food cache ──────────────────────────────────────────────────────
// USDA foods are immutable per (dataset version, fdc_id), so a never-expiring D1
// cache lets a hot fdc_id skip the R2 range-read + JSON/zod parse on every
// lookup. cubby only ever resolves a few hundred distinct foods (its products'
// fdc_ids), so the cache stays tiny; after a warm-up pass a recompute fan-out is
// pure D1 (two ~0.5ms reads, no R2). Scoped by version so a dataset re-import
// transparently uses a fresh cache.
const FOOD_CACHE_TABLE = "food_cache";
let foodCacheEnsured = false;

async function ensureFoodCacheTable(db: D1Database): Promise<void> {
  if (foodCacheEnsured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${FOOD_CACHE_TABLE} (
         version TEXT NOT NULL,
         fdc_id INTEGER NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (version, fdc_id)
       )`,
    )
    .run();
  foodCacheEnsured = true;
}

/** Parsed foods already cached for this version, keyed by fdc_id. */
async function readFoodCache(
  db: D1Database,
  version: string,
  fdcIds: number[],
): Promise<Map<number, FoodSummary>> {
  const out = new Map<number, FoodSummary>();
  if (fdcIds.length === 0) return out;
  await ensureFoodCacheTable(db);
  for (let i = 0; i < fdcIds.length; i += MAX_SQL_VARIABLES - 1) {
    const chunk = fdcIds.slice(i, i + MAX_SQL_VARIABLES - 1);
    const placeholders = chunk.map(() => "?").join(", ");
    const res = await db
      .prepare(
        `SELECT fdc_id, data FROM ${FOOD_CACHE_TABLE} WHERE version = ? AND fdc_id IN (${placeholders})`,
      )
      .bind(version, ...chunk)
      .all<{ fdc_id: number; data: string }>();
    for (const row of res.results ?? []) {
      // Validated when written; trust it and skip the re-parse (that's the point).
      out.set(row.fdc_id, JSON.parse(row.data) as FoodSummary);
    }
  }
  return out;
}

/**
 * Persist newly-hydrated foods so future lookups skip R2. `INSERT OR IGNORE` so a
 * cold fan-out where many concurrent requests miss the same food don't conflict.
 */
async function writeFoodCache(
  db: D1Database,
  version: string,
  foods: FoodSummary[],
): Promise<void> {
  if (foods.length === 0) return;
  const stmts = foods.map((food) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO ${FOOD_CACHE_TABLE} (version, fdc_id, data) VALUES (?, ?, ?)`,
      )
      .bind(version, food.fdc_id, JSON.stringify(food)),
  );
  await db.batch(stmts);
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

  // USDA bundle bytes are immutable, so the per-food range read is pure static
  // work that's repeated on every lookup. Cache the hydrated JSON in the
  // colo-local Cache API keyed on the exact R2 pointer (bundle_key + byte
  // range): a dataset re-import writes new keys/offsets, so the key naturally
  // invalidates without a manual purge.
  async function readBundleText(
    row: FoodIndexRow,
    stats?: HydrateStats,
  ): Promise<string | null> {
    // `caches.default` is a Cloudflare extension absent from the DOM
    // CacheStorage type (mirrors the cast in the web USDA client); it's also
    // absent under Node (unit tests), so guard before use and read R2 directly.
    const cache =
      typeof caches !== "undefined"
        ? (caches as unknown as { default: Cache }).default
        : null;
    const cacheKey = new Request(
      `https://usda-cache/food/${encodeURIComponent(row.bundle_key)}/${row.byte_offset}/${row.byte_length}`,
    );
    const cached = cache ? await cache.match(cacheKey) : undefined;
    if (cached) {
      if (stats) stats.cacheHits += 1;
      return cached.text();
    }

    const object = await env.USDA_BUNDLES.get(row.bundle_key, {
      range: {
        offset: row.byte_offset,
        length: row.byte_length,
      },
    });
    if (!object) return null;

    const text = await object.text();
    if (stats) {
      stats.r2Reads += 1;
      stats.bytesRead += text.length;
    }
    await cache?.put(
      cacheKey,
      new Response(text, {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      }),
    );
    return text;
  }

  async function hydrate(
    row: FoodIndexRow | null,
    stats?: HydrateStats,
  ): Promise<FoodSummary | null> {
    if (!row) return null;

    const text = await readBundleText(row, stats);
    if (text === null) return null;
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
    // R2 range-read + JSON/zod parse per row. Traced so a slow lookup shows
    // whether the time is R2 (cacheMisses/bytesRead) vs the index query above.
    const stats: HydrateStats = { cacheHits: 0, r2Reads: 0, bytesRead: 0 };
    return withSpan("usda.hydrateRows", async (span) => {
      const result = await pMap(rows, (row) => hydrate(row, stats), {
        concurrency: r2Concurrency,
      });
      span.setAttributes({
        rowCount: rows.length,
        cacheHits: stats.cacheHits,
        r2Reads: stats.r2Reads,
        bytesRead: stats.bytesRead,
      });
      return result;
    });
  }

  async function findRowByColumn(
    column: "gtin_upc" | "ndb_number",
    value: string | number,
  ): Promise<FoodIndexRow | null> {
    const tables = await getActiveVersion(env.DB);
    return env.DB.prepare(
      `SELECT * FROM ${tables.foodIndex} WHERE ${column} = ? ORDER BY fdc_id ASC LIMIT 1`,
    )
      .bind(value)
      .first<FoodIndexRow>();
  }

  // Trace one single-food lookup as a span: the D1 index hit + the R2 hydrate,
  // with the same cacheHits/r2Reads/bytesRead attrs as the batch path. This is
  // the `/api/foods/search` path that product enrichment (api.usda.findByLookup)
  // takes — previously an opaque gap inside the usda-api root span. The D1 query
  // itself is auto-instrumented by the platform and nests under this span.
  function tracedSingle(
    name: string,
    attrs: Record<string, SpanAttr>,
    fetchRow: () => Promise<FoodIndexRow | null>,
  ): Promise<FoodSummary | null> {
    return withSpan(
      name,
      async (span) => {
        const stats: HydrateStats = { cacheHits: 0, r2Reads: 0, bytesRead: 0 };
        const row = await fetchRow();
        const food = await hydrate(row, stats);
        span.setAttributes({
          indexHit: row !== null,
          found: food !== null,
          cacheHits: stats.cacheHits,
          r2Reads: stats.r2Reads,
          bytesRead: stats.bytesRead,
        });
        return food;
      },
      attrs,
    );
  }

  // Index-lookup phase for a batch: build one prepared statement per
  // (column, ≤100-value chunk) and issue them ALL in a single `env.DB.batch()`
  // round trip, rather than awaiting each chunk serially. D1 returns results in
  // statement order, so each is folded back into its column's keyed map.
  async function lookupIndexRows(
    columns: { column: LookupColumn; values: Array<string | number> }[],
  ): Promise<Map<LookupColumn, Map<string | number, FoodIndexRow>>> {
    const tables = await getActiveVersion(env.DB);
    const maps = new Map<LookupColumn, Map<string | number, FoodIndexRow>>(
      columns.map(({ column }) => [column, new Map()]),
    );

    const specs: { column: LookupColumn; stmt: D1PreparedStatement }[] = [];
    for (const { column, values } of columns) {
      for (let i = 0; i < values.length; i += MAX_SQL_VARIABLES) {
        const chunk = values.slice(i, i + MAX_SQL_VARIABLES);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        specs.push({
          column,
          stmt: env.DB.prepare(
            `SELECT * FROM ${tables.foodIndex} WHERE ${column} IN (${placeholders}) ORDER BY ${column} ASC, fdc_id ASC`,
          ).bind(...chunk),
        });
      }
    }
    if (specs.length === 0) return maps;

    const results = await env.DB.batch<FoodIndexRow>(specs.map((s) => s.stmt));
    results.forEach((result, idx) => {
      const spec = specs[idx];
      const map = spec && maps.get(spec.column);
      if (!spec || !map) return;
      for (const row of rowsFromResult(result)) {
        const key =
          spec.column === "gtin_upc"
            ? row.gtin_upc
            : spec.column === "ndb_number"
              ? row.ndb_number
              : row.fdc_id;
        if (key !== null && !map.has(key)) map.set(key, row);
      }
    });
    return maps;
  }

  return {
    async getCounts() {
      const tables = await getActiveVersion(env.DB);
      const key = manifestKey(tables.version);
      // The manifest is immutable per dataset version (a re-import writes a new
      // key), so cache the parsed counts in the colo-local Cache API keyed by
      // version — turning the per-request R2 read + JSON parse into a cache hit.
      // Same `caches.default` guard as readBundleText (absent under Node tests).
      const cache =
        typeof caches !== "undefined"
          ? (caches as unknown as { default: Cache }).default
          : null;
      const cacheKey = new Request(
        `https://usda-cache/counts/${encodeURIComponent(key)}`,
      );
      const cached = cache ? await cache.match(cacheKey) : undefined;
      if (cached) {
        return countsSchema.parse(await cached.json());
      }

      const object = await env.USDA_BUNDLES.get(key);
      if (!object) {
        throw new Error(`Missing USDA edge manifest: ${key}`);
      }
      const manifest = JSON.parse(await object.text()) as Manifest;
      const counts = countsSchema.parse(manifest.counts);
      await cache?.put(
        cacheKey,
        new Response(JSON.stringify(counts), {
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        }),
      );
      return counts;
    },

    getFoodById(fdcId) {
      return tracedSingle("usda.getFoodById", { fdcId }, () =>
        getPointerByFdcId(fdcId),
      );
    },

    findFoodByUpc(gtinUpc) {
      return tracedSingle("usda.findFoodByUpc", { gtin_upc: gtinUpc }, () =>
        findRowByColumn("gtin_upc", gtinUpc),
      );
    },

    findFoodByNdb(ndbNumber) {
      return tracedSingle("usda.findFoodByNdb", { ndb_number: ndbNumber }, () =>
        findRowByColumn("ndb_number", ndbNumber),
      );
    },

    async findFoodsByLookupBatch(lookups: FoodLookupParam[]) {
      if (lookups.length === 0) return [];
      return withSpan(
        "usda.findFoodsByLookupBatch",
        async (span) => {
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
          const fdcIds = Array.from(
            new Set(
              lookups
                .filter((lookup) => lookup.kind === "fdc")
                .map((lookup) => lookup.fdc_id),
            ),
          );

          // D1 index lookup phase (3 parallel IN queries), traced separately
          // from hydration so a slow batch shows whether it's the index or R2.
          const [upcRows, ndbRows, fdcRows] = await withSpan(
            "usda.indexLookup",
            async (indexSpan) => {
              const maps = await lookupIndexRows([
                { column: "gtin_upc", values: upcs },
                { column: "ndb_number", values: ndbNumbers },
                { column: "fdc_id", values: fdcIds },
              ]);
              const upc = maps.get("gtin_upc") ?? new Map();
              const ndb = maps.get("ndb_number") ?? new Map();
              const fdc = maps.get("fdc_id") ?? new Map();
              indexSpan.setAttribute(
                "indexRowCount",
                upc.size + ndb.size + fdc.size,
              );
              return [upc, ndb, fdc] as const;
            },
            {
              upcCount: upcs.length,
              ndbCount: ndbNumbers.length,
              fdcCount: fdcIds.length,
            },
          );

          const rows = lookups.map((lookup) => {
            if (lookup.kind === "upc")
              return upcRows.get(lookup.gtin_upc) ?? null;
            if (lookup.kind === "ndb")
              return ndbRows.get(lookup.ndb_number) ?? null;
            return fdcRows.get(lookup.fdc_id) ?? null;
          });

          const uniqueRows = new Map<number, FoodIndexRow>();
          for (const row of rows) {
            if (row) uniqueRows.set(row.fdc_id, row);
          }
          const uniqueRowList = [...uniqueRows.values()];
          span.setAttribute("uniqueRowCount", uniqueRowList.length);

          // Serve already-resolved foods straight from the D1 cache (no R2, no
          // parse); hydrate ONLY the misses from R2, then cache them. This is what
          // makes a recompute fan-out cheap — the same few hundred foods are
          // re-requested constantly, and after warm-up they're all cache hits.
          const tables = await getActiveVersion(env.DB);
          const cached = await readFoodCache(
            env.DB,
            tables.version,
            uniqueRowList.map((row) => row.fdc_id),
          );
          const missRows = uniqueRowList.filter(
            (row) => !cached.has(row.fdc_id),
          );
          span.setAttribute(
            "cacheHits",
            uniqueRowList.length - missRows.length,
          );
          span.setAttribute("cacheMisses", missRows.length);

          const hydratedMisses = await hydrateRows(missRows);
          await writeFoodCache(
            env.DB,
            tables.version,
            hydratedMisses.filter((food): food is FoodSummary => food !== null),
          );

          const hydratedById = new Map<number, FoodSummary | null>();
          for (const [id, food] of cached) hydratedById.set(id, food);
          missRows.forEach((row, i) => {
            hydratedById.set(row.fdc_id, hydratedMisses[i] ?? null);
          });

          return rows.map((row) =>
            row ? (hydratedById.get(row.fdc_id) ?? null) : null,
          );
        },
        { lookupCount: lookups.length },
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

      // Relevance ordering only means something with an FTS query. We bucket by
      // data_type richness FIRST so the complete reference foods lead and the
      // ~2M branded duplicates don't bury them (the long-standing picker pain).
      // WITHIN a bucket we then prefer exact/prefix description matches and
      // shorter descriptions (mimicking USDA FDC) BEFORE bm25 `rank` — because
      // raw bm25 over-rewards rows that repeat the query tokens (e.g. "VANILLA
      // BEAN COCONUTMILK, VANILLA BEAN") and sinks the literal short match.
      // These extra `?`s bind AFTER the WHERE values and BEFORE LIMIT/OFFSET, by
      // SQL appearance order. Without a name filter, fall back to alphabetical.
      const orderValues: string[] = [];
      let orderClause: string;
      if (orderBy === "relevance") {
        if (hasName) {
          const term = nameFilter?.trim() ?? "";
          orderValues.push(term, `${escapeLike(term)}%`);
          orderClause = `${dataTypePriorityCase(`${tables.foodSearch}.data_type`)} ASC, ${matchQualityCase("i.description")} ASC, LENGTH(i.description) ASC, ${tables.foodSearch}.rank ASC`;
        } else {
          orderClause = "i.description ASC";
        }
      } else {
        orderClause = `i.${sqlOrderBy(orderBy)} ${sqlDirection(direction)}`;
      }

      // Data and count queries are independent — run them in one round trip.
      const [result, countRow] = await Promise.all([
        env.DB.prepare(
          `SELECT i.*
           FROM ${dataFrom}
           ${where}
           ORDER BY ${orderClause}
           LIMIT ? OFFSET ?`,
        )
          .bind(...values, ...orderValues, pageSize, offset)
          .all<FoodIndexRow>(),
        env.DB.prepare(`SELECT count(*) as count FROM ${countFrom} ${where}`)
          .bind(...values)
          .first<{ count: number }>(),
      ]);
      const rows = rowsFromResult(result);
      const totalCount = countRow?.count ?? 0;

      const data = (await hydrateRows(rows)).filter(
        (food): food is FoodSummary => food !== null,
      );
      return { data, count: totalCount } satisfies ListFoodsResult;
    },
  };
}
