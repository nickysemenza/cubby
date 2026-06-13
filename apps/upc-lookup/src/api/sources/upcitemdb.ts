import type { ExternalProductData, UPCitemdbResponse } from "../types";
import { extractBestPrice } from "../price";
import type { ProductSource } from "./types";

const UPCITEMDB_API_URL = "https://api.upcitemdb.com/prod/trial/lookup";
const TIMEOUT_MS = 5000;

/**
 * Look up product data from UPCitemdb.
 * Free trial tier: ~100 requests/day (cached results don't count against it).
 */
export async function lookupUPCitemdb(
  upc: string,
): Promise<ExternalProductData | null> {
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
      console.error(`UPCitemdb API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as UPCitemdbResponse;

    if (!data.items || data.items.length === 0) {
      return null;
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
      name: item.title,
      manufacturer: null, // UPCitemdb doesn't have manufacturer
      brand: item.brand || null,
      category: item.category || null,
      description: item.description || null,
      priceDollars,
      imageUrl: item.images && item.images.length > 0 ? item.images[0]! : null,
      source: "upcitemdb",
      sourceData: JSON.stringify(data),
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      console.error("UPCitemdb API timeout");
    } else {
      console.error("UPCitemdb API error:", error);
    }
    return null;
  }
}

export const upcitemdb = {
  name: "upcitemdb",
  lookup: lookupUPCitemdb,
} as const satisfies ProductSource;
