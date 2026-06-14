import type { ExternalLookupResult, UPCitemdbResponse } from "../types";
import { extractBestPrice } from "../price";
import type { ProductSource } from "./types";

const UPCITEMDB_API_URL = "https://api.upcitemdb.com/prod/trial/lookup";
const TIMEOUT_MS = 5000;

/**
 * Look up product data from UPCitemdb.
 * Free trial tier: ~100 requests/day (cached results don't count against it).
 *
 * Returns `not_found` only for a definitive empty result (HTTP 200 with no
 * items, or a 404). A non-OK status (notably 429 rate-limit / 5xx) or a
 * timeout is `error` — transient, so callers must not cache it as a miss.
 */
export async function lookupUPCitemdb(
  upc: string,
): Promise<ExternalLookupResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${UPCITEMDB_API_URL}?upc=${upc}`, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // 404 = definitively absent; anything else (429/5xx) = transient.
      if (response.status === 404) return { status: "not_found" };
      console.error(`UPCitemdb API error: ${response.status}`);
      return { status: "error" };
    }

    const data = (await response.json()) as UPCitemdbResponse;

    if (!data.items || data.items.length === 0) {
      return { status: "not_found" };
    }

    const item = data.items[0]!;

    // Extract best price from offers (API returns dollars)
    let priceDollars: number | null = null;
    if (item.offers && item.offers.length > 0) {
      priceDollars = extractBestPrice(item.offers);
    }
    // Fallback to lowest_recorded_price if no valid offers
    if (
      priceDollars === null &&
      item.lowest_recorded_price &&
      item.lowest_recorded_price > 0
    ) {
      priceDollars = item.lowest_recorded_price;
    }

    return {
      status: "found",
      data: {
        name: item.title,
        manufacturer: null, // UPCitemdb doesn't have manufacturer
        brand: item.brand || null,
        category: item.category || null,
        description: item.description || null,
        priceDollars,
        imageUrl:
          item.images && item.images.length > 0 ? item.images[0]! : null,
        source: "upcitemdb",
        sourceData: JSON.stringify(data),
      },
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      console.error("UPCitemdb API timeout");
    } else {
      console.error("UPCitemdb API error:", error);
    }
    // Transient (timeout / network) — not a definitive miss.
    return { status: "error" };
  }
}

export const upcitemdb = {
  name: "upcitemdb",
  lookup: lookupUPCitemdb,
} as const satisfies ProductSource;
