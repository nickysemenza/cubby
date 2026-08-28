import { type ExternalLookupResult, upcitemdbResponseSchema } from "../types";
import { extractBestPrice } from "../price";
import type { ProductSource } from "./types";

const UPCITEMDB_API_URL = "https://api.upcitemdb.com/prod/trial/lookup";
const TIMEOUT_MS = 5000;

/** The UPC source's only environmental dependencies. */
export interface UPCitemdbRuntime {
  fetch: typeof fetch;
  timeoutSignal: (milliseconds: number) => AbortSignal;
}

const productionUPCitemdbRuntime: UPCitemdbRuntime = {
  fetch,
  timeoutSignal: AbortSignal.timeout,
};

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
  runtime: UPCitemdbRuntime = productionUPCitemdbRuntime,
): Promise<ExternalLookupResult> {
  try {
    const response = await runtime.fetch(`${UPCITEMDB_API_URL}?upc=${upc}`, {
      headers: {
        Accept: "application/json",
      },
      signal: runtime.timeoutSignal(TIMEOUT_MS),
    });

    if (!response.ok) {
      // 404 = definitively absent; anything else (429/5xx) = transient.
      if (response.status === 404) return { status: "not_found" };
      console.error(`UPCitemdb API error: ${response.status}`);
      return { status: "error" };
    }

    const parsed = upcitemdbResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      // A changed/malformed upstream shape is transient from our side — do NOT
      // cache it as a miss; surface as an error so the UPC is retried later.
      console.error("UPCitemdb malformed response:", parsed.error);
      return { status: "error" };
    }
    const data = parsed.data;

    if (data.items.length === 0) {
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
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
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
