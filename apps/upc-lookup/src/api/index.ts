import { lookupUPCitemdb } from "./upcitemdb";
import type { ExternalProductData } from "./types";

export type { ExternalProductData } from "./types";

/**
 * Look up product data from UPCitemdb.
 * Free tier: 100 requests/day (cached results don't count against limit)
 */
export async function lookupExternalProduct(
  upc: string
): Promise<ExternalProductData | null> {
  return lookupUPCitemdb(upc);
}
