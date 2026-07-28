import { countsSchema } from "@cubby/usda-contract";
import type { FoodLookupParam, FoodSummary } from "@cubby/usda-schemas";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { type SpanAttr, withSpan } from "@cubby/worker-tracing";
import { toFtsQuery } from "../search/fts-query.js";
import { manifestKey } from "./artifact-layout.js";
import {
  createFoodBundleLoader,
  type FoodIndexRow,
  type HydrateStats,
} from "./edge-bundle-loader.js";
import {
  dataTypePredicate,
  dataTypePriorityCase,
  escapeLike,
  matchQualityCase,
  sqlDirection,
  sqlOrderBy,
} from "./edge-index-query.js";
import { getActiveVersion } from "./edge-version.js";
import type { EdgeBindings } from "./cloudflare-types.js";
import { readFoodCache, writeFoodCache } from "./food-cache.js";
import type { Counts, ListFoodsResult, USDADataSource } from "./types.js";

export {
  dataTypePredicate,
  dataTypePriorityCase,
  escapeLike,
  FOOD_DATA_TYPES,
  matchQualityCase,
} from "./edge-index-query.js";
export { normalizeUpc } from "./edge-bundle-loader.js";

const MAX_SQL_VARIABLES = 100;
const DEFAULT_CONCURRENCY = 50;

type LookupColumn = "gtin_upc" | "ndb_number" | "fdc_id";

interface Manifest {
  counts: Counts;
}

function rowsFromResult<T>(result: { results?: T[]; success: boolean }): T[] {
  if (!result.success) {
    throw new Error("D1 query failed");
  }
  return result.results ?? [];
}

export function createEdgeUsdaDataSource(
  env: EdgeBindings,
  options: { r2Concurrency?: number } = {},
): USDADataSource {
  const r2Concurrency = options.r2Concurrency ?? DEFAULT_CONCURRENCY;
  const { hydrate, hydrateRows } = createFoodBundleLoader(env, r2Concurrency);

  async function getPointerByFdcId(
    fdcId: number,
  ): Promise<FoodIndexRow | null> {
    const tables = await getActiveVersion(env.DB);
    return env.DB.prepare(`SELECT * FROM ${tables.foodIndex} WHERE fdc_id = ?`)
      .bind(fdcId)
      .first<FoodIndexRow>();
  }

  // `fdc_id DESC` is load-bearing, not cosmetic: one barcode maps to several
  // rows because FDC mints a NEW fdc_id every time a branded item is
  // republished, so the highest id is the latest revision and the lowest is the
  // oldest — routinely one with no nutrients at all. Picking ASC silently
  // resolved products to those empty records, which is the
  // `ingredient -> product -> fdc_id` nutrition hop landing on nothing. Matches
  // the tiebreak `dedupeUsdaFoodsByUpc` uses on the cubby side. Don't "tidy"
  // this back to ASC.
  async function findRowByColumn(
    column: "gtin_upc" | "ndb_number",
    value: string | number,
  ): Promise<FoodIndexRow | null> {
    const tables = await getActiveVersion(env.DB);
    return env.DB.prepare(
      `SELECT * FROM ${tables.foodIndex} WHERE ${column} = ? ORDER BY fdc_id DESC LIMIT 1`,
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
            // `fdc_id DESC` + the first-wins fold below keeps the NEWEST row
            // per key, matching findRowByColumn — see its comment for why. The
            // single and batch paths must agree, or a product resolves to a
            // different food depending on which one enrichment happened to take.
            `SELECT * FROM ${tables.foodIndex} WHERE ${column} IN (${placeholders}) ORDER BY ${column} ASC, fdc_id DESC`,
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
      if (cache) {
        try {
          const cached = await cache.match(cacheKey);
          if (cached) {
            try {
              return countsSchema.parse(await cached.json());
            } catch (err) {
              console.warn(
                "[counts-cache] ignoring unparseable cached counts",
                err,
              );
            }
          }
        } catch (err) {
          console.warn("[counts-cache] read failed; falling back to R2", err);
        }
      }

      const object = await env.USDA_BUNDLES.get(key);
      if (!object) {
        throw new Error(`Missing USDA edge manifest: ${key}`);
      }
      const manifest = JSON.parse(await object.text()) as Manifest;
      const counts = countsSchema.parse(manifest.counts);
      try {
        await cache?.put(
          cacheKey,
          new Response(JSON.stringify(counts), {
            headers: { "Cache-Control": "public, max-age=31536000, immutable" },
          }),
        );
      } catch (err) {
        console.warn(
          "[counts-cache] write failed; continuing without cache",
          err,
        );
      }
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
          // The trailing `i.fdc_id ASC` is a stability tiebreak, not a
          // preference: without a unique terminal key, rows tied on all four
          // ranking keys come back in SQLite-defined order, which makes
          // LIMIT/OFFSET paging non-deterministic — the same row can appear on
          // two pages, or on neither.
          orderClause = `${dataTypePriorityCase(`${tables.foodSearch}.data_type`)} ASC, ${matchQualityCase("i.description")} ASC, LENGTH(i.description) ASC, ${tables.foodSearch}.rank ASC, i.fdc_id ASC`;
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
