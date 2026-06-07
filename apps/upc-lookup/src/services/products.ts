import type { Database } from "../db";
import type { Env } from "../types";
import type { Product } from "../db/schema";
import { getProduct, createProduct } from "../db/products";
import { lookupExternalProduct } from "../api";
import { storeImage } from "../storage/images";

export type ResolveResult = { product: Product; cached: boolean };

/**
 * Resolve a UPC to a cached product: return the cached row if present,
 * otherwise look it up via the source registry, store its image, and cache it.
 * Returns null if no source had data. Shared by the `/lookup` route and the
 * `lookup_upc` MCP tool so the two can't drift.
 */
export async function resolveProduct(
  db: Database,
  env: Env,
  upc: string,
): Promise<ResolveResult | null> {
  const existing = await getProduct(db, upc);
  if (existing) {
    return { product: existing, cached: true };
  }

  const data = await lookupExternalProduct(upc);
  if (!data) return null;

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

  return { product, cached: false };
}
