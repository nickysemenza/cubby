/**
 * Durable cache for advisory UPC enrichment.
 *
 * This is intentionally a repo seam: callers provide the provider operation,
 * while this module owns the persistent freshness contract. A failed provider
 * call never replaces a last-known answer with an empty successful result.
 */
import type { UPCLookupResponse } from "@cubby/upc-contract";
import { inArray, sql } from "drizzle-orm";

import { PartialUpcBatchLookupError } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import { upcLookupCache } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/** Provider data is advisory; refresh at most once per UPC per week. */
const UPC_LOOKUP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type UpcEnrichmentFreshness = {
  /** fresh = all candidate answers checked this interval; stale = cached data survived an outage. */
  status: "fresh" | "stale" | "unavailable";
  /** Server time at which this view determined its provider state. */
  checkedAt: Date;
  /** Oldest cached answer used for this view, null when nothing was available. */
  oldestFetchedAt: Date | null;
  /** Number of candidate UPCs without a usable answer after the attempt. */
  unavailableCount: number;
};

type CachedUpcLookup = {
  upc: string;
  manufacturer: string | null;
  brand: string | null;
  priceDollars: number | null;
  imageUrl: string | null;
  status: string;
  fetchedAt: Date;
};

const isFresh = (row: CachedUpcLookup, now: Date) =>
  row.status === "ready" &&
  now.getTime() - row.fetchedAt.getTime() < UPC_LOOKUP_CACHE_MAX_AGE_MS;

const toLookup = (row: CachedUpcLookup): UPCLookupResponse => ({
  upc: row.upc,
  name: "",
  manufacturer: row.manufacturer,
  brand: row.brand,
  category: null,
  description: null,
  priceDollars: row.priceDollars,
  imageUrl: row.imageUrl,
  // Cache is materialized here, regardless of whether the upstream provider
  // had its own cache bit. The caller only needs proposal fields.
  source: "upcitemdb",
  cached: true,
});

const writeLookups = async (
  db: Database,
  requestedUpcs: readonly string[],
  hits: ReadonlyMap<string, UPCLookupResponse>,
  fetchedAt: Date,
) => {
  if (requestedUpcs.length === 0) return;
  await getDb(db)
    .insert(upcLookupCache)
    .values(
      requestedUpcs.map((upc) => {
        const hit = hits.get(upc);
        return {
          upc,
          manufacturer: hit?.manufacturer ?? null,
          brand: hit?.brand ?? null,
          priceDollars: hit?.priceDollars ?? null,
          imageUrl: hit?.imageUrl ?? null,
          // A missing map entry is a checked negative answer, not a provider
          // error: this function only runs after lookupBatch resolved.
          status: "ready",
          fetchedAt,
        };
      }),
    )
    .onConflictDoUpdate({
      target: upcLookupCache.upc,
      set: {
        manufacturer: sql`excluded."manufacturer"`,
        brand: sql`excluded."brand"`,
        priceDollars: sql`excluded."priceDollars"`,
        imageUrl: sql`excluded."imageUrl"`,
        status: "ready",
        fetchedAt,
      },
    });
};

/** Record a failed first lookup without erasing a last-known ready answer. */
const writeUnavailable = async (
  db: Database,
  upcs: readonly string[],
  fetchedAt: Date,
) => {
  if (upcs.length === 0) return;
  await getDb(db)
    .insert(upcLookupCache)
    .values(upcs.map((upc) => ({ upc, status: "unavailable", fetchedAt })))
    .onConflictDoNothing({ target: upcLookupCache.upc });
};

const readyCacheRow = (
  upc: string,
  hit: UPCLookupResponse | undefined,
  fetchedAt: Date,
): CachedUpcLookup => ({
  upc,
  manufacturer: hit?.manufacturer ?? null,
  brand: hit?.brand ?? null,
  priceDollars: hit?.priceDollars ?? null,
  imageUrl: hit?.imageUrl ?? null,
  status: "ready",
  fetchedAt,
});

const applyReadyCacheRows = (
  cached: Map<string, CachedUpcLookup>,
  upcs: readonly string[],
  hits: ReadonlyMap<string, UPCLookupResponse>,
  fetchedAt: Date,
) => {
  for (const upc of upcs)
    cached.set(upc, readyCacheRow(upc, hits.get(upc), fetchedAt));
};

const refreshUpcCache = async (
  db: Database,
  refresh: string[],
  cached: Map<string, CachedUpcLookup>,
  checkedAt: Date,
  lookupBatch: (upcs: string[]) => Promise<Map<string, UPCLookupResponse>>,
): Promise<boolean> => {
  if (refresh.length === 0) return false;
  try {
    const hits = await lookupBatch(refresh);
    await writeLookups(db, refresh, hits, checkedAt);
    applyReadyCacheRows(cached, refresh, hits, checkedAt);
    return false;
  } catch (error) {
    console.error("[readCachedUpcLookups] UPC provider refresh failed:", error);
    const partial = error instanceof PartialUpcBatchLookupError ? error : null;
    const failed = new Set(partial?.failedUpcs ?? refresh);
    const completed = refresh.filter((upc) => !failed.has(upc));
    if (partial) {
      await writeLookups(db, completed, partial.results, checkedAt);
      applyReadyCacheRows(cached, completed, partial.results, checkedAt);
    }
    const firstFailures = [...failed].filter((upc) => !cached.has(upc));
    await writeUnavailable(db, firstFailures, checkedAt);
    for (const upc of firstFailures) {
      cached.set(upc, {
        upc,
        manufacturer: null,
        brand: null,
        priceDollars: null,
        imageUrl: null,
        status: "unavailable",
        fetchedAt: checkedAt,
      });
    }
    return true;
  }
};

/**
 * Load cached UPC answers, refreshing only absent/stale rows. If refresh
 * fails, preserve stale cached answers and explicitly report unavailable UPCs.
 */
export const readCachedUpcLookups = async (
  db: Database,
  upcs: readonly string[],
  lookupBatch: (upcs: string[]) => Promise<Map<string, UPCLookupResponse>>,
): Promise<{
  lookups: Map<string, UPCLookupResponse>;
  freshness: UpcEnrichmentFreshness;
}> => {
  const requested = [...new Set(upcs)];
  const checkedAt = new Date();
  if (requested.length === 0) {
    return {
      lookups: new Map(),
      freshness: {
        status: "fresh",
        checkedAt,
        oldestFetchedAt: null,
        unavailableCount: 0,
      },
    };
  }

  const rows = await getDb(db)
    .select()
    .from(upcLookupCache)
    .where(inArray(upcLookupCache.upc, requested));
  const cached = new Map(rows.map((row) => [row.upc, row]));
  const refresh = requested.filter((upc) => {
    const row = cached.get(upc);
    return !row || !isFresh(row, checkedAt);
  });

  const providerFailed = await refreshUpcCache(
    db,
    refresh,
    cached,
    checkedAt,
    lookupBatch,
  );

  const lookups = new Map<string, UPCLookupResponse>();
  const usedRows = requested
    .map((upc) => cached.get(upc))
    .filter(
      (row): row is CachedUpcLookup => row != null && row.status === "ready",
    );
  for (const row of usedRows) lookups.set(row.upc, toLookup(row));

  const unavailableCount = requested.filter(
    (upc) => cached.get(upc)?.status !== "ready",
  ).length;
  const oldestFetchedAt = usedRows.reduce<Date | null>(
    (oldest, row) =>
      oldest == null || row.fetchedAt < oldest ? row.fetchedAt : oldest,
    null,
  );
  const status = providerFailed
    ? usedRows.length > 0
      ? "stale"
      : "unavailable"
    : "fresh";

  return {
    lookups,
    freshness: { status, checkedAt, oldestFetchedAt, unavailableCount },
  };
};
