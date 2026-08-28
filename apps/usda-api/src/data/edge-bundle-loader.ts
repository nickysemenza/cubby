import { foodSummary, type FoodSummary } from "@cubby/usda-schemas";
import { withSpan } from "@cubby/worker-tracing";
import pMap from "p-map";
import { z } from "zod";
import { normalizeDataType } from "./artifact-layout.js";
import type { EdgeBindings } from "./cloudflare-types.js";

export interface HydrateStats {
  cacheHits: number;
  r2Reads: number;
  bytesRead: number;
}

export interface FoodIndexRow {
  fdc_id: number;
  data_type: string;
  description: string;
  gtin_upc: string | null;
  ndb_number: number | null;
  bundle_key: string;
  byte_offset: number;
  byte_length: number;
}

const legacyFoodPayload = z.looseObject({
  foodInfo: z.looseObject({ data_type: z.string().optional() }).nullish(),
  brandedFoodInfo: z.looseObject({ gtin_upc: z.string().optional() }).nullish(),
});

// The seeded v20260611 artifacts predate build-time normalization and still
// contain the `market_acquistion` typo in R2 bundles, so this must run at
// read time until a re-seeded version is activated.
function parseFoodSummaryText(text: string): FoodSummary {
  const payload = legacyFoodPayload.parse(JSON.parse(text));
  if (payload.foodInfo?.data_type) {
    payload.foodInfo.data_type = normalizeDataType(payload.foodInfo.data_type);
  }
  if (payload.brandedFoodInfo?.gtin_upc) {
    payload.brandedFoodInfo.gtin_upc = normalizeUpc(
      payload.brandedFoodInfo.gtin_upc,
    );
  }
  return foodSummary.parse(payload);
}

// USDA branded UPCs are sometimes stored with leading zeros stripped (e.g. an
// 11-digit value for a 12-digit UPC-A), which fails the >=12-char schema and
// 500s response validation. Left-pad short numeric UPCs to 12 — both fixing the
// crash and matching how products store UPCs for linking. Non-numeric or
// already-valid values pass through untouched.
export function normalizeUpc(upc: string): string {
  return /^\d{1,11}$/.test(upc) ? upc.padStart(12, "0") : upc;
}

export function createFoodBundleLoader(
  env: EdgeBindings,
  r2Concurrency: number,
) {
  // USDA bundle bytes are immutable, so the per-food range read is pure static
  // work that's repeated on every lookup. Cache the hydrated JSON in the
  // colo-local Cache API keyed on the exact R2 pointer (bundle_key + byte
  // range): a dataset re-import writes new keys/offsets, so the key naturally
  // invalidates without a manual purge.
  async function readBundleText(
    row: FoodIndexRow,
    stats?: HydrateStats,
    options: { skipCacheRead?: boolean } = {},
  ): Promise<{ text: string; fromCache: boolean } | null> {
    // `caches.default` is a Cloudflare extension absent from the DOM
    // CacheStorage type (mirrors the cast in the web USDA client); it's also
    // absent under Node (unit tests), so guard before use and read R2 directly.
    const cache = globalThis.caches?.default ?? null;
    const cacheKey = new Request(
      `https://usda-cache/food/${encodeURIComponent(row.bundle_key)}/${row.byte_offset}/${row.byte_length}`,
    );
    if (cache && !options.skipCacheRead) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          try {
            const text = await cached.text();
            if (stats) stats.cacheHits += 1;
            return { text, fromCache: true };
          } catch (err) {
            console.warn(
              `[bundle-cache] read body failed for ${row.fdc_id}; falling back to R2`,
              err,
            );
          }
        }
      } catch (err) {
        console.warn(
          `[bundle-cache] read failed for ${row.fdc_id}; falling back to R2`,
          err,
        );
      }
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
    try {
      await cache?.put(
        cacheKey,
        new Response(text, {
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        }),
      );
    } catch (err) {
      console.warn(
        `[bundle-cache] write failed for ${row.fdc_id}; continuing without cache`,
        err,
      );
    }
    return { text, fromCache: false };
  }

  async function hydrate(
    row: FoodIndexRow | null,
    stats?: HydrateStats,
  ): Promise<FoodSummary | null> {
    if (!row) return null;

    const bundle = await readBundleText(row, stats);
    if (bundle === null) return null;
    const loadFreshAfterCacheFailure = async () => {
      const fresh = await readBundleText(row, stats, { skipCacheRead: true });
      if (fresh === null) return null;
      let freshParsed: FoodSummary;
      try {
        freshParsed = parseFoodSummaryText(fresh.text);
      } catch (err) {
        console.warn(`[hydrate] skipping unparseable food ${row.fdc_id}`, err);
        return null;
      }
      if (freshParsed.fdc_id !== row.fdc_id) {
        throw new Error(
          `R2 pointer mismatch for ${row.fdc_id}: read ${freshParsed.fdc_id}`,
        );
      }
      return freshParsed;
    };
    // A single malformed record must not 500 the whole page: drop it (callers
    // filter nulls / treat null as not-found). This makes a page slightly
    // shorter than totalCount (the count is from the index, not hydrated rows) —
    // an acceptable trade for resilience against bad source data. Pointer
    // mismatch below still throws: that's index corruption, not data quality.
    let parsed: FoodSummary;
    try {
      parsed = parseFoodSummaryText(bundle.text);
    } catch (err) {
      if (bundle.fromCache) {
        console.warn(
          `[hydrate] ignoring unparseable cached food ${row.fdc_id}`,
          err,
        );
        return loadFreshAfterCacheFailure();
      }
      console.warn(`[hydrate] skipping unparseable food ${row.fdc_id}`, err);
      return null;
    }
    if (parsed.fdc_id !== row.fdc_id) {
      if (bundle.fromCache) {
        console.warn(
          `[hydrate] ignoring cached pointer mismatch for ${row.fdc_id}: read ${parsed.fdc_id}`,
        );
        return loadFreshAfterCacheFailure();
      }
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

  return { hydrate, hydrateRows };
}
