import type { ExternalProductData } from "./types";
import { SOURCES } from "./sources";

export type { ExternalProductData } from "./types";
export { SOURCES, SOURCE_NAMES, type SourceName } from "./sources";

/**
 * Look up product data from the external source registry.
 *
 * Tries each source in {@link SOURCES} order and returns the first non-null
 * hit, or null if none match. Add sources by editing `./sources/index.ts`.
 */
export async function lookupExternalProduct(
  upc: string,
): Promise<ExternalProductData | null> {
  for (const source of SOURCES) {
    const result = await source.lookup(upc);
    if (result) return result;
  }
  return null;
}
