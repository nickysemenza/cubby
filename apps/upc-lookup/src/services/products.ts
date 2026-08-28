import type { Database } from "../db";
import type { Env } from "../types";
import type { NewProduct, Product } from "../db/schema";
import { createResolvedProduct, getProduct } from "../db/products";
import { deleteMiss, getFreshMisses, recordMiss } from "../db/misses";
import { lookupExternalProduct } from "../api";
import { cleanupImageVariants, storeImage } from "../storage/images";
import type { ExternalLookupResult } from "../api";

export type ResolveResult = { product: Product; cached: boolean };

/** Dependencies for the resolution state machine, independent of D1/R2. */
export interface ProductResolutionDependencies {
  getProduct(upc: string): Promise<Product | undefined>;
  getFreshMisses(upcs: string[]): Promise<Set<string>>;
  recordMiss(upc: string): Promise<void>;
  deleteMiss(upc: string): Promise<void>;
  lookupExternalProduct(upc: string): Promise<ExternalLookupResult>;
  storeImage(upc: string, imageUrl: string): Promise<string | null>;
  createResolvedProduct(values: NewProduct): Promise<Product | undefined>;
  cleanupImageVariants(
    upc: string,
    currentImageKey: string | null,
  ): Promise<void>;
}

function createDefaultDependencies(
  db: Database,
  env: Env,
): ProductResolutionDependencies {
  return {
    getProduct: (upc) => getProduct(db, upc),
    getFreshMisses: (upcs) => getFreshMisses(db, upcs),
    recordMiss: (upc) => recordMiss(db, upc),
    deleteMiss: (upc) => deleteMiss(db, upc),
    lookupExternalProduct,
    storeImage: (upc, imageUrl) => storeImage(upc, imageUrl, env),
    createResolvedProduct: (values) => createResolvedProduct(db, values),
    cleanupImageVariants: (upc, currentImageKey) =>
      cleanupImageVariants(env, upc, currentImageKey),
  };
}

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
  return resolveProductOutcomeWithDependencies(
    createDefaultDependencies(db, env),
    upc,
    opts,
  );
}

/** Run resolution against an explicit adapter, useful for faithful interface tests. */
export async function resolveProductOutcomeWithDependencies(
  dependencies: ProductResolutionDependencies,
  upc: string,
  opts: { force?: boolean } = {},
): Promise<ResolveOutcome> {
  const existing = await dependencies.getProduct(upc);
  if (existing) {
    return { status: "found", product: existing, cached: true };
  }

  // Already tried and known-missing within the TTL — don't re-query the API.
  // `force` skips this guard for an explicit manual retry (the admin "Re-try"
  // button), which must re-hit the API even inside the TTL window.
  if (!opts.force) {
    const freshMisses = await dependencies.getFreshMisses([upc]);
    if (freshMisses.has(upc)) {
      return { status: "not_found" };
    }
  }

  const lookup = await dependencies.lookupExternalProduct(upc);
  if (lookup.status === "error") {
    // Transient — do not record a miss; retry on a later pass.
    return { status: "error" };
  }
  if (lookup.status === "not_found") {
    await dependencies.recordMiss(upc);
    return { status: "not_found" };
  }

  const data = lookup.data;
  const imageKey = data.imageUrl
    ? await dependencies.storeImage(upc, data.imageUrl)
    : null;

  const product = await dependencies.createResolvedProduct({
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

  if (!product) {
    const winner = await dependencies.getProduct(upc);
    if (!winner) {
      throw new Error(`Product ${upc} was not found after an insert conflict`);
    }
    await dependencies.cleanupImageVariants(upc, winner.imageKey);
    return { status: "found", product: winner, cached: true };
  }

  // The UPC graduated to a real product — clear any stale miss row.
  await dependencies.deleteMiss(upc);

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
