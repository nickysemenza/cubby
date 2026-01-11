import type { Amount } from "~/codec/codec";
import { wasm } from "~/lib/wasm";

/**
 * Checks if a unit represents money/currency using WASM
 */
export const isMoneyUnit = (unit: string): boolean => {
  try {
    return wasm.amount_kind({ value: 1, unit }) === "money";
  } catch {
    return false;
  }
};

/**
 * Checks if an amount represents a single unit (1 each)
 */
const isSingleEach = (amount: Amount): boolean =>
  amount.value === 1 && amount.unit === "each";

/**
 * Checks if a mapping is a canonical price mapping (1 each <-> $X)
 * Works in either direction (a or b can be the price).
 */
export const isCanonicalPriceMapping = (mapping: {
  a: Amount;
  b: Amount;
}): boolean => {
  return (
    (isSingleEach(mapping.a) && isMoneyUnit(mapping.b.unit)) ||
    (isSingleEach(mapping.b) && isMoneyUnit(mapping.a.unit))
  );
};

interface PriceMappingMatch<T> {
  /** The matched mapping object */
  match: T;
  /** Index in the original array */
  index: number;
  /** The price amount (includes currency unit) */
  price: Amount;
}

/**
 * Find a price mapping (1 each <-> $X) in either direction.
 * Price can be in either 'a' or 'b' position.
 * Returns the matched object, its index, and the price Amount.
 *
 * This is the single source of truth for price mapping detection,
 * used by both in-memory array operations and database operations.
 */
export const findPriceMapping = <T extends { a: Amount; b: Amount }>(
  mappings: T[],
): PriceMappingMatch<T> | null => {
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]!;
    if (isCanonicalPriceMapping(m)) {
      // Determine which side has the price
      const price = isMoneyUnit(m.b.unit) ? m.b : m.a;
      return { match: m, index: i, price };
    }
  }
  return null;
};

/**
 * Extracts price amount from unit mappings (finds "1 each <-> $X" mapping)
 * Handles price in either 'a' or 'b' position.
 * Returns full Amount to preserve currency info.
 */
export const extractPriceFromMappings = (
  mappings: Array<{ a: Amount; b: Amount }>,
): Amount | null => {
  const match = findPriceMapping(mappings);
  return match?.price ?? null;
};

/**
 * Compute the price value to store in the product.price column.
 * Uses WASM to detect price mappings - single source of truth.
 * Returns just the numeric value (assumes USD for storage).
 */
export const computeProductPrice = (
  unitMappings: Array<{ a: Amount; b: Amount }>,
): number | null => {
  const priceAmount = extractPriceFromMappings(unitMappings);
  return priceAmount?.value ?? null;
};

/**
 * Compute the valuation (total value) for an inventory entry.
 * Simple multiplication of quantity by unit price.
 */
export const computeInventoryValuation = (
  amountValue: number,
  productPrice: number | null,
): number | null => {
  if (productPrice === null) return null;
  return amountValue * productPrice;
};

/** Default currency unit when creating new price mappings */
const DEFAULT_CURRENCY = "dollar";

/**
 * Creates or updates a price mapping in an array of unit mappings
 * Pure function - returns a new array.
 *
 * Always normalizes to canonical format: 1 each <-> $X (a=each, b=price)
 * When updating, preserves the existing currency unit.
 * When creating new, uses provided currency or defaults to "dollar".
 */
export const syncPriceToMappings = <
  T extends { a: Amount; b: Amount; source?: string | null },
>(
  mappings: T[],
  price: Amount | null,
  source: string = "manual",
): T[] => {
  const existing = findPriceMapping(mappings);

  if (price === null) {
    // Remove price mapping if it exists
    if (existing) {
      return mappings.filter((_, i) => i !== existing.index);
    }
    return mappings;
  }

  // Use provided currency, or preserve existing, or default
  const currency = price.unit || existing?.price.unit || DEFAULT_CURRENCY;

  // Always normalize to canonical format: 1 each <-> $X
  const priceMapping = {
    ...(existing ? mappings[existing.index] : {}),
    a: { value: 1, unit: "each" },
    b: { value: price.value, unit: currency },
    source: existing ? (mappings[existing.index]?.source ?? source) : source,
  } as T;

  if (existing) {
    // Update existing mapping
    return mappings.map((m, i) => (i === existing.index ? priceMapping : m));
  } else {
    // Add new mapping
    return [...mappings, priceMapping];
  }
};

/**
 * Serializes non-canonical-price unit mappings to a semicolon-separated string
 *
 * Filters out ONLY the canonical price mapping (1 each = $X) which is exported
 * to the price column. All other mappings, including non-canonical price mappings
 * like "2 oz = $8", are included in the output.
 */
export const serializeUnitMappings = (
  mappings: Array<{ a: Amount; b: Amount; source: string | null }>,
): string | null => {
  // Filter out ONLY the canonical price mapping (1 each = $X)
  // Keep all other mappings, including non-canonical price mappings like "2 oz = $8"
  const canonicalPriceMapping = findPriceMapping(mappings);

  const nonPriceMappings = canonicalPriceMapping
    ? mappings.filter((_, index) => index !== canonicalPriceMapping.index)
    : mappings;

  if (nonPriceMappings.length === 0) return null;

  // Round to 6 decimal places to avoid floating point precision churn
  const formatNum = (n: number) => {
    const rounded = Math.round(n * 1000000) / 1000000;
    return rounded.toString();
  };

  return nonPriceMappings
    .map((m) => {
      const sourceStr = m.source ? ` @ ${m.source}` : "";
      return `${formatNum(m.a.value)} ${m.a.unit} = ${formatNum(m.b.value)} ${m.b.unit}${sourceStr}`;
    })
    .join("; ");
};
