import { z } from "zod";
import type { SourceName } from "./sources";

// Common product data extracted from external APIs
export interface ExternalProductData {
  name: string;
  manufacturer: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  priceDollars: number | null; // USD
  imageUrl: string | null;
  source: SourceName;
  sourceData: string; // Full JSON response
}

/**
 * Outcome of an external lookup. Distinguishing `not_found` (the UPC is
 * genuinely absent — safe to cache as a miss) from `error` (transient: rate
 * limit / 5xx / timeout — must NOT be cached, retry later) is what keeps a
 * temporarily rate-limited UPC from being recorded as permanently missing.
 */
export type ExternalLookupResult =
  | { status: "found"; data: ExternalProductData }
  | { status: "not_found" }
  | { status: "error" };

// UPCitemdb API response — zod-validated at the fetch boundary (sources/
// upcitemdb.ts) so a changed/malformed upstream payload fails loud as a
// transient error instead of silently producing bad cached products.
// `looseObject` preserves unknown keys so the full payload is still stored in
// `sourceData`. Only the fields we actually consume are required; everything
// else is optional, so a sparse-but-valid item is not rejected.
export const upcitemdbOfferSchema = z.looseObject({
  merchant: z.string().optional(),
  domain: z.string().optional(),
  title: z.string(),
  currency: z.string().optional(),
  list_price: z.string().optional(),
  price: z.number(),
  shipping: z.string().optional(),
  condition: z.string().optional(),
  availability: z.string().optional(),
  link: z.string().optional(),
  updated_t: z.number().optional(),
});
export type UPCitemdbOffer = z.infer<typeof upcitemdbOfferSchema>;

export const upcitemdbItemSchema = z.looseObject({
  ean: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  upc: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  size: z.string().optional(),
  dimension: z.string().optional(),
  weight: z.string().optional(),
  category: z.string().optional(),
  currency: z.string().optional(),
  lowest_recorded_price: z.number().optional(),
  highest_recorded_price: z.number().optional(),
  images: z.array(z.string()).optional(),
  offers: z.array(upcitemdbOfferSchema).optional(),
});
export type UPCitemdbItem = z.infer<typeof upcitemdbItemSchema>;

export const upcitemdbResponseSchema = z.looseObject({
  code: z.string().optional(),
  total: z.number().optional(),
  offset: z.number().optional(),
  items: z.array(upcitemdbItemSchema).optional(),
});
export type UPCitemdbResponse = z.infer<typeof upcitemdbResponseSchema>;
