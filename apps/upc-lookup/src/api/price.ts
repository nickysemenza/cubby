import type { UPCitemdbOffer } from "./types";

// Patterns indicating multi-pack offers (case insensitive)
const MULTIPACK_PATTERNS = [
  /pack of ?\d+/i, // "Pack of 4" or "Pack of4"
  /case of ?\d+/i, // "Case of 4" or "Case of4"
  /\(\d+x\d+/i, // (4x5lb)
  /\d+x\d+lb/i, // 4x5lb
  /- \d+ pack/i, // - 4 pack
  /\bset of ?\d+/i, // "Set of 4"
  /\(\d+-pack\)/i, // (4-pack)
];

/**
 * Check if an offer title indicates a multi-pack
 */
export function isMultiPack(title: string): boolean {
  return MULTIPACK_PATTERNS.some((pattern) => pattern.test(title));
}

/**
 * Extract the best price from offers
 * Strategy: Filter out $0 and multi-packs, then use median price
 */
export function extractBestPrice(offers: UPCitemdbOffer[]): number | null {
  // Get valid prices (non-zero, not multi-packs)
  const validPrices = offers
    .filter((offer) => offer.price > 0 && !isMultiPack(offer.title))
    .map((offer) => offer.price);

  if (validPrices.length === 0) {
    // Fallback: use any non-zero price
    const anyPrice = offers.find((o) => o.price > 0)?.price;
    return anyPrice ?? null;
  }

  // Use median to avoid outliers
  validPrices.sort((a, b) => a - b);
  const mid = Math.floor(validPrices.length / 2);
  return validPrices.length % 2 !== 0
    ? validPrices[mid]
    : (validPrices[mid - 1] + validPrices[mid]) / 2;
}
