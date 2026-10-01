/**
 * Durable store for UPC identity answers (`UpcLookupCache`).
 *
 * This is intentionally a repo seam: callers provide the provider operation,
 * while this module owns the persistent freshness contract. A failed provider
 * call never replaces a last-known answer with an empty successful result.
 * `manual` rows (hand-entered, imported from the retired lookup Worker) are
 * authoritative and are never overwritten or aged out by a provider refresh.
 */
import type { UpcEnrichmentFreshness } from "@cubby/schemas/problems";
import { createLogger } from "@cubby/worker-tracing";
import { count, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";

import {
  productSourceSchema,
  type UPCLookupResponse,
} from "~/contracts/upc.schemas";
import type { Database } from "~/server/db";
import { upcLookupCache } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

const log = createLogger("UPC cache");

/** A multi-UPC provider refresh failed partially; completed UPCs remain usable. */
export class PartialUpcBatchLookupError extends Error {
  constructor(
    cause: Error,
    readonly results: ReadonlyMap<string, UPCLookupResponse>,
    readonly failedUpcs: readonly string[],
  ) {
    super(cause.message, { cause });
    this.name = "PartialUpcBatchLookupError";
  }
}

/** Provider data is advisory; refresh at most once per UPC per week. */
const UPC_LOOKUP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type CachedUpcLookup = {
  upc: string;
  name: string | null;
  manufacturer: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  priceDollars: number | null;
  imageUrl: string | null;
  source: string;
  status: string;
  fetchedAt: Date;
};

const isFresh = (row: CachedUpcLookup, now: Date) =>
  row.status === "ready" &&
  (row.source === "manual" ||
    now.getTime() - row.fetchedAt.getTime() < UPC_LOOKUP_CACHE_MAX_AGE_MS);

/** A ready row with a name is a product answer; without one it is a checked miss. */
export const isUpcHit = (row: CachedUpcLookup) =>
  row.status === "ready" && row.name != null;

export const toUpcLookup = (row: CachedUpcLookup): UPCLookupResponse => ({
  upc: row.upc,
  name: row.name ?? "",
  manufacturer: row.manufacturer,
  brand: row.brand,
  category: row.category,
  description: row.description,
  priceDollars: row.priceDollars,
  imageUrl: row.imageUrl,
  source: productSourceSchema.catch("upcitemdb").parse(row.source),
  cached: true,
});

const providerFields = (hit: UPCLookupResponse | undefined) => ({
  name: hit?.name ?? null,
  manufacturer: hit?.manufacturer ?? null,
  brand: hit?.brand ?? null,
  category: hit?.category ?? null,
  description: hit?.description ?? null,
  priceDollars: hit?.priceDollars ?? null,
  imageUrl: hit?.imageUrl ?? null,
  source: hit?.source ?? "upcitemdb",
});

/** Cached rows (hits, checked misses and unavailable markers) for these UPCs. */
export const getCachedUpcRows = async (
  db: Database,
  upcs: readonly string[],
): Promise<CachedUpcLookup[]> =>
  upcs.length === 0
    ? []
    : getDb(db)
        .select()
        .from(upcLookupCache)
        .where(inArray(upcLookupCache.upc, [...upcs]));

/**
 * Record provider answers for every requested UPC: a hit stores its fields, an
 * absent entry stores a checked miss. Never overwrites a `manual` row.
 */
export const recordUpcLookups = async (
  db: Database,
  requestedUpcs: readonly string[],
  hits: ReadonlyMap<string, UPCLookupResponse>,
  fetchedAt: Date,
) => {
  if (requestedUpcs.length === 0) return;
  await getDb(db)
    .insert(upcLookupCache)
    .values(
      requestedUpcs.map((upc) => ({
        upc,
        ...providerFields(hits.get(upc)),
        // A missing map entry is a checked negative answer, not a provider
        // error: this function only runs after the provider call resolved.
        status: "ready",
        fetchedAt,
      })),
    )
    .onConflictDoUpdate({
      target: upcLookupCache.upc,
      set: {
        name: sql`excluded."name"`,
        manufacturer: sql`excluded."manufacturer"`,
        brand: sql`excluded."brand"`,
        category: sql`excluded."category"`,
        description: sql`excluded."description"`,
        priceDollars: sql`excluded."priceDollars"`,
        imageUrl: sql`excluded."imageUrl"`,
        source: sql`excluded."source"`,
        status: "ready",
        fetchedAt,
      },
      // Hand-entered rows win over every provider answer.
      setWhere: sql`${upcLookupCache.source} <> 'manual'`,
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

/** Case-insensitive substring search over cached product identity. */
export const searchCachedUpcs = async (
  db: Database,
  query: string,
  limit: number,
): Promise<{ rows: CachedUpcLookup[]; total: number }> => {
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const where = sql`${isNotNull(upcLookupCache.name)} AND (${or(
    ilike(upcLookupCache.name, pattern),
    ilike(upcLookupCache.brand, pattern),
    ilike(upcLookupCache.manufacturer, pattern),
  )})`;
  const [rows, [total]] = await Promise.all([
    getDb(db).select().from(upcLookupCache).where(where).limit(limit),
    getDb(db).select({ n: count() }).from(upcLookupCache).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
};

const readyCacheRow = (
  upc: string,
  hit: UPCLookupResponse | undefined,
  fetchedAt: Date,
): CachedUpcLookup => ({
  upc,
  ...providerFields(hit),
  status: "ready",
  fetchedAt,
});

const applyReadyCacheRows = (
  cached: Map<string, CachedUpcLookup>,
  upcs: readonly string[],
  hits: ReadonlyMap<string, UPCLookupResponse>,
  fetchedAt: Date,
) => {
  for (const upc of upcs) {
    // A manual row is never replaced, so keep serving it from memory too.
    if (cached.get(upc)?.source === "manual") continue;
    cached.set(upc, readyCacheRow(upc, hits.get(upc), fetchedAt));
  }
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
    await recordUpcLookups(db, refresh, hits, checkedAt);
    applyReadyCacheRows(cached, refresh, hits, checkedAt);
    return false;
  } catch (error) {
    log.error("UPC provider refresh failed", { error });
    const partial = error instanceof PartialUpcBatchLookupError ? error : null;
    const failed = new Set(partial?.failedUpcs ?? refresh);
    const completed = refresh.filter((upc) => !failed.has(upc));
    if (partial) {
      await recordUpcLookups(db, completed, partial.results, checkedAt);
      applyReadyCacheRows(cached, completed, partial.results, checkedAt);
    }
    const firstFailures = [...failed].filter((upc) => !cached.has(upc));
    await writeUnavailable(db, firstFailures, checkedAt);
    for (const upc of firstFailures) {
      cached.set(upc, {
        upc,
        ...providerFields(undefined),
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

  const rows = await getCachedUpcRows(db, requested);
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
  for (const row of usedRows) {
    if (isUpcHit(row)) lookups.set(row.upc, toUpcLookup(row));
  }

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
