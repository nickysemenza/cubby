/**
 * UPC identity lookups served from Postgres `UpcLookupCache`, with upcitemdb
 * as the upstream fallback. Replaces the retired `upc-lookup` Worker.
 *
 * - `lookup`: cached hit, else (unless a fresh checked miss) one upstream call.
 * - `lookupBatch`: the provider function under `readCachedUpcLookups`; reuses
 *   cached hits, then asks upstream for the rest, stopping at the first
 *   transient failure so a rate limit is not hammered.
 * - `search`: substring search over cached identities (hand-entered and
 *   previously looked-up products).
 */
import { createLogger } from "@cubby/worker-tracing";

import type {
  SearchResponse,
  UPCLookupResponse,
} from "~/contracts/upc.schemas";
import { env } from "~/env";
import type { Database } from "~/server/db";
import {
  getCachedUpcRows,
  isUpcHit,
  PartialUpcBatchLookupError,
  recordUpcLookups,
  searchCachedUpcs,
  toUpcLookup,
} from "~/server/repo/upc-lookup-cache";
import { TraceNames, withTrace } from "~/server/tracing";

import type { ExternalLookupResult } from "./types";
import { lookupUPCitemdb } from "./upcitemdb";

const log = createLogger("UPC Lookup");

/** Checked misses are retried after this long (negative-cache TTL). */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Upstream calls per batch. The free upcitemdb tier allows ~100 lookups/day, so
 * a large backlog drains over several passes; the remainder reports as
 * unavailable and is retried on the next problem scan.
 */
const BATCH_UPSTREAM_LIMIT = 25;

export { PartialUpcBatchLookupError };

export type UpcUpstream = (upc: string) => Promise<ExternalLookupResult>;

const toResponse = (
  upc: string,
  result: Extract<ExternalLookupResult, { status: "found" }>,
): UPCLookupResponse => ({
  upc,
  name: result.data.name,
  manufacturer: result.data.manufacturer,
  brand: result.data.brand,
  category: result.data.category,
  description: result.data.description,
  priceDollars: result.data.priceDollars,
  imageUrl: result.data.imageUrl,
  source: result.data.source,
  cached: false,
});

export class UpcLookupService {
  constructor(
    private readonly db: Database,
    /** Null disables upstream calls (offline dev and E2E): cache reads only. */
    private readonly upstream: UpcUpstream | null,
  ) {}

  async lookup(upc: string): Promise<UPCLookupResponse | null> {
    return withTrace(TraceNames.api("upc-lookup", "lookup"), async () => {
      const [row] = await getCachedUpcRows(this.db, [upc]);
      if (row && isUpcHit(row)) return toUpcLookup(row);
      const freshMiss =
        row?.status === "ready" &&
        Date.now() - row.fetchedAt.getTime() < MISS_TTL_MS;
      if (freshMiss || !this.upstream) return null;

      const result = await this.upstream(upc);
      if (result.status === "error") return null; // transient: never cached
      const checkedAt = new Date();
      if (result.status === "not_found") {
        await recordUpcLookups(this.db, [upc], new Map(), checkedAt);
        return null;
      }
      const hit = toResponse(upc, result);
      await recordUpcLookups(this.db, [upc], new Map([[upc, hit]]), checkedAt);
      return hit;
    });
  }

  /**
   * Hits for the requested UPCs; UPCs with no data are absent. Throws
   * {@link PartialUpcBatchLookupError} when upstream failed for some UPCs so
   * callers can tell an empty answer from an outage.
   */
  async lookupBatch(upcs: string[]): Promise<Map<string, UPCLookupResponse>> {
    const result = new Map<string, UPCLookupResponse>();
    if (upcs.length === 0) return result;
    return withTrace(TraceNames.api("upc-lookup", "lookupBatch"), async () => {
      const unique = [...new Set(upcs)];
      for (const row of await getCachedUpcRows(this.db, unique)) {
        if (isUpcHit(row)) result.set(row.upc, toUpcLookup(row));
      }
      const upstream = this.upstream;
      if (!upstream) return result;

      const pending = unique.filter((upc) => !result.has(upc));
      const failedUpcs: string[] = [];
      let failure: Error | null = null;
      for (const [index, upc] of pending.entries()) {
        if (failure || index >= BATCH_UPSTREAM_LIMIT) {
          failedUpcs.push(upc);
          continue;
        }
        const outcome = await upstream(upc);
        if (outcome.status === "found") {
          result.set(upc, toResponse(upc, outcome));
        } else if (outcome.status === "error") {
          failure = new Error("UPC provider is unavailable");
          failedUpcs.push(upc);
        }
      }
      if (failedUpcs.length > 0) {
        log.warn(`Batch left ${failedUpcs.length} UPCs unresolved`);
        throw new PartialUpcBatchLookupError(
          failure ?? new Error("UPC provider batch limit reached"),
          result,
          failedUpcs,
        );
      }
      return result;
    });
  }

  async search(query: string, limit = 20): Promise<SearchResponse> {
    const { rows, total } = await searchCachedUpcs(this.db, query, limit);
    return {
      products: rows.map((row) => {
        const { cached: _cached, ...product } = toUpcLookup(row);
        return product;
      }),
      total,
    };
  }
}

export type UpcLookupPort = Pick<UpcLookupService, "lookup" | "lookupBatch">;

export const createUpcLookupService = (db: Database): UpcLookupService =>
  new UpcLookupService(
    db,
    env.UPC_UPSTREAM_DISABLED === "true" ? null : lookupUPCitemdb,
  );
