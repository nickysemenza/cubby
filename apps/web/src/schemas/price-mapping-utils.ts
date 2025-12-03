import { type Amount } from "~/codec/codec";
import { type wasm } from "~/hooks/useWasm";

/**
 * Checks if a unit represents money/currency using WASM
 * @param w - WASM instance for dynamic unit detection
 * @param unit - Unit string to check
 * @returns true if unit is a money/currency unit
 */
export const isMoneyUnit = (w: wasm, unit: string): boolean => {
  try {
    return w.measure_kind({ value: 1, unit }) === "money";
  } catch {
    return false;
  }
};

/**
 * Extracts price value from unit mappings (finds "1 each → $X" mapping)
 * @param w - WASM instance for money unit detection
 * @param mappings - Array of unit mappings to search
 * @returns Price value or null if no price mapping found
 */
export const extractPriceFromMappings = (
  w: wasm,
  mappings: Array<{ a: Amount; b: Amount }>,
): number | null => {
  const priceMapping = mappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && isMoneyUnit(w, m.b.unit),
  );
  return priceMapping?.b.value ?? null;
};

/**
 * Creates or updates a price mapping in an array of unit mappings
 * Pure function - returns a new array
 * @param w - WASM instance for money unit detection
 * @param mappings - Current unit mappings array
 * @param price - New price value (null to remove price mapping)
 * @param source - Source string for the mapping (e.g., "product-form", "csv-import")
 * @returns New array with price mapping added/updated/removed
 */
export const syncPriceToMappings = <
  T extends { a: Amount; b: Amount; source?: string | null },
>(
  w: wasm,
  mappings: T[],
  price: number | null,
  source: string = "manual",
): T[] => {
  // Find existing price mapping index (any money unit)
  const existingIndex = mappings.findIndex(
    (m) => m.a.value === 1 && m.a.unit === "each" && isMoneyUnit(w, m.b.unit),
  );

  if (price === null) {
    // Remove price mapping if it exists
    if (existingIndex >= 0) {
      return mappings.filter((_, i) => i !== existingIndex);
    }
    return mappings;
  }

  const priceMapping = {
    ...(existingIndex >= 0 ? mappings[existingIndex] : {}),
    a: { value: 1, unit: "each" },
    b: { value: price, unit: "dollar" },
    source:
      existingIndex >= 0 ? (mappings[existingIndex]?.source ?? source) : source,
  } as T;

  if (existingIndex >= 0) {
    // Update existing mapping
    return mappings.map((m, i) => (i === existingIndex ? priceMapping : m));
  } else {
    // Add new mapping
    return [...mappings, priceMapping];
  }
};

/**
 * Serializes non-price unit mappings to a semicolon-separated string
 * @param w - WASM instance for money unit detection
 * @param mappings - Array of unit mappings
 * @returns Serialized string or null if no non-price mappings
 */
export const serializeUnitMappings = (
  w: wasm,
  mappings: Array<{ a: Amount; b: Amount; source: string | null }>,
): string | null => {
  // Filter out price mappings (where either a or b is a money unit)
  const nonPriceMappings = mappings.filter(
    (m) => !isMoneyUnit(w, m.a.unit) && !isMoneyUnit(w, m.b.unit),
  );
  if (nonPriceMappings.length === 0) return null;
  return nonPriceMappings
    .map((m) => {
      const sourceStr = m.source ? ` @ ${m.source}` : "";
      return `${m.a.value} ${m.a.unit} = ${m.b.value} ${m.b.unit}${sourceStr}`;
    })
    .join("; ");
};
