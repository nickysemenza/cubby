import { type Amount } from "~/codec/codec";
import { wasmServer } from "~/lib/wasm";

/**
 * Checks if a unit represents money/currency using WASM
 */
export const isMoneyUnit = async (unit: string): Promise<boolean> => {
  try {
    return (await wasmServer.amount_kind({ value: 1, unit })) === "money";
  } catch {
    return false;
  }
};

/**
 * Checks if an amount represents a single unit (1 each)
 */
export const isSingleEach = (amount: Amount): boolean =>
  amount.value === 1 && amount.unit === "each";

interface PriceMappingMatch {
  index: number;
  /** The price amount (includes currency unit) */
  price: Amount;
}

/**
 * Find a price mapping (1 each <-> $X) in either direction.
 * Price can be in either 'a' or 'b' position.
 * Always returns the price Amount (the side with money).
 */
const findPriceMappingInArray = async <T extends { a: Amount; b: Amount }>(
  mappings: T[],
): Promise<PriceMappingMatch | null> => {
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]!;
    // Check if b is money and a is "1 each"
    if (isSingleEach(m.a) && (await isMoneyUnit(m.b.unit))) {
      return { index: i, price: m.b };
    }
    // Check if a is money and b is "1 each"
    if (isSingleEach(m.b) && (await isMoneyUnit(m.a.unit))) {
      return { index: i, price: m.a };
    }
  }
  return null;
};

/**
 * Extracts price amount from unit mappings (finds "1 each <-> $X" mapping)
 * Handles price in either 'a' or 'b' position.
 * Returns full Amount to preserve currency info.
 */
export const extractPriceFromMappings = async (
  mappings: Array<{ a: Amount; b: Amount }>,
): Promise<Amount | null> => {
  const match = await findPriceMappingInArray(mappings);
  return match?.price ?? null;
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
export const syncPriceToMappings = async <
  T extends { a: Amount; b: Amount; source?: string | null },
>(
  mappings: T[],
  price: Amount | null,
  source: string = "manual",
): Promise<T[]> => {
  const existing = await findPriceMappingInArray(mappings);

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
 * Serializes non-price unit mappings to a semicolon-separated string
 */
export const serializeUnitMappings = async (
  mappings: Array<{ a: Amount; b: Amount; source: string | null }>,
): Promise<string | null> => {
  // Check each mapping for money units
  const results = await Promise.all(
    mappings.map(async (m) => ({
      ...m,
      isMoneyA: await isMoneyUnit(m.a.unit),
      isMoneyB: await isMoneyUnit(m.b.unit),
    })),
  );
  const nonPriceMappings = results.filter((m) => !m.isMoneyA && !m.isMoneyB);
  if (nonPriceMappings.length === 0) return null;
  return nonPriceMappings
    .map((m) => {
      const sourceStr = m.source ? ` @ ${m.source}` : "";
      return `${m.a.value} ${m.a.unit} = ${m.b.value} ${m.b.unit}${sourceStr}`;
    })
    .join("; ");
};
