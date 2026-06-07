import type { ExternalProductData } from "../types";

/**
 * A pluggable external product-data source.
 *
 * Each source resolves a UPC to product data or `null` if it has no match.
 * To add a source: implement this interface and register it in `./index.ts`.
 */
export interface ProductSource {
  /** Stable identifier persisted to the `source` column. */
  readonly name: string;
  lookup(upc: string): Promise<ExternalProductData | null>;
}
