import type { ExternalUpcProductSource } from "@cubby/upc-contract";
import type { ExternalLookupResult } from "../types";

/**
 * A pluggable external product-data source.
 *
 * Each source resolves a UPC to a discriminated {@link ExternalLookupResult}:
 * `found` with data, `not_found` (genuinely absent), or `error` (transient).
 * To add a source: implement this interface and register it in `./index.ts`.
 */
export interface ProductSource {
  /** Stable identifier persisted to the `source` column. */
  readonly name: ExternalUpcProductSource;
  lookup(upc: string): Promise<ExternalLookupResult>;
}
