import type { Database } from "../db";
import type { Env } from "../types";
import type { Product } from "../db/schema";
import { getProduct, createProduct } from "../db/products";
import { deleteMiss, getFreshMisses, recordMiss } from "../db/misses";
import { lookupExternalProduct } from "../api";
import { storeImage } from "../storage/images";

export type ResolveResult = { product: Product; cached: boolean };

/**
 * Outcome of resolving a UPC:
 * - `found`: a cached row, or a fresh external hit we just stored.
 * - `not_found`: no source had data (now recorded as a miss, or already a
 *   fresh miss we skipped re-querying).
 * - `error`: a transient external failure (rate limit / 5xx / timeout). NOT
 *   cached — the caller can stop early and retry later.
 */
export type ResolveOutcome =
  | { status: "found"; product: Product; cached: boolean }
  | { status: "not_found" }
  | { status: "error" };

/**
 * Resolve a UPC, returning a discriminated {@link ResolveOutcome}. Shared core
 * for the `/lookup` route, the bulk first-try loop, and the MCP tool so they
 * can't drift. Every UPC hits the external API at most once per TTL: a hit is
 * cached as a product, a definitive miss is cached in `upc_misses`, and a
 * transient error is left uncached for a later retry.
 */
export async function resolveProductOutcome(
  db: Database,
  env: Env,
  upc: string,
  opts: { force?: boolean } = {},
): Promise<ResolveOutcome> {
  const existing = await getProduct(db, upc);
  if (existing) {
    return { status: "found", product: existing, cached: true };
  }

  // Already tried and known-missing within the TTL — don't re-query the API.
  // `force` skips this guard for an explicit manual retry (the admin "Re-try"
  // button), which must re-hit the API even inside the TTL window.
  if (!opts.force) {
    const freshMisses = await getFreshMisses(db, [upc]);
    if (freshMisses.has(upc)) {
      return { status: "not_found" };
    }
  }

  const lookup = await lookupExternalProduct(upc);
  if (lookup.status === "error") {
    // Transient — do not record a miss; retry on a later pass.
    return { status: "error" };
  }
  if (lookup.status === "not_found") {
    await recordMiss(db, upc);
    return { status: "not_found" };
  }

  const data = lookup.data;
  const imageKey = data.imageUrl
    ? await storeImage(upc, data.imageUrl, env)
    : null;

  const product = await createProduct(db, {
    upc,
    name: data.name,
    manufacturer: data.manufacturer,
    brand: data.brand,
    category: data.category,
    description: data.description,
    priceDollars: data.priceDollars,
    imageKey,
    source: data.source,
    sourceData: data.sourceData,
  });

  // The UPC graduated to a real product — clear any stale miss row.
  await deleteMiss(db, upc);

  return { status: "found", product, cached: false };
}

/**
 * Thin wrapper over {@link resolveProductOutcome} for callers that only need
 * "the product or nothing" (the `/lookup/:upc` route and the MCP tool). A
 * transient `error` collapses to `null`, same as a true miss.
 */
export async function resolveProduct(
  db: Database,
  env: Env,
  upc: string,
): Promise<ResolveResult | null> {
  const outcome = await resolveProductOutcome(db, env, upc);
  return outcome.status === "found"
    ? { product: outcome.product, cached: outcome.cached }
    : null;
}
