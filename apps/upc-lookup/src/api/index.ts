import type { ExternalLookupResult } from "./types";
import { SOURCES } from "./sources";

export type { ExternalProductData, ExternalLookupResult } from "./types";
export { SOURCES, SOURCE_NAMES, type SourceName } from "./sources";

/**
 * Look up product data from the external source registry.
 *
 * Tries each source in {@link SOURCES} order and returns the first `found`
 * hit. If no source had data, returns `not_found` — unless any source failed
 * transiently (`error`), in which case it returns `error` so the caller does
 * not cache a miss it can't be sure about. Add sources via `./sources/index.ts`.
 */
export async function lookupExternalProduct(
  upc: string,
): Promise<ExternalLookupResult> {
  let sawError = false;
  for (const source of SOURCES) {
    const result = await source.lookup(upc);
    if (result.status === "found") return result;
    if (result.status === "error") sawError = true;
  }
  return sawError ? { status: "error" } : { status: "not_found" };
}
