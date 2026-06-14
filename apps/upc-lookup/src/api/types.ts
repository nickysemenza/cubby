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

// UPCitemdb API response types
export interface UPCitemdbResponse {
  code: string;
  total: number;
  offset: number;
  items: UPCitemdbItem[];
}

export interface UPCitemdbItem {
  ean: string;
  title: string;
  description?: string;
  upc?: string;
  brand?: string;
  model?: string;
  color?: string;
  size?: string;
  dimension?: string;
  weight?: string;
  category?: string;
  currency?: string;
  lowest_recorded_price?: number;
  highest_recorded_price?: number;
  images?: string[];
  offers?: UPCitemdbOffer[];
}

export interface UPCitemdbOffer {
  merchant: string;
  domain: string;
  title: string;
  currency: string;
  list_price?: string;
  price: number;
  shipping?: string;
  condition?: string;
  availability?: string;
  link: string;
  updated_t: number;
}
