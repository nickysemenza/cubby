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
 * Extracts price value from unit mappings (finds "1 each → $X" mapping)
 */
export const extractPriceFromMappings = async (
  mappings: Array<{ a: Amount; b: Amount }>,
): Promise<number | null> => {
  for (const m of mappings) {
    if (
      m.a.value === 1 &&
      m.a.unit === "each" &&
      (await isMoneyUnit(m.b.unit))
    ) {
      return m.b.value;
    }
  }
  return null;
};

/**
 * Creates or updates a price mapping in an array of unit mappings
 * Pure function - returns a new array
 */
export const syncPriceToMappings = async <
  T extends { a: Amount; b: Amount; source?: string | null },
>(
  mappings: T[],
  price: number | null,
  source: string = "manual",
): Promise<T[]> => {
  // Find existing price mapping index (any money unit)
  let existingIndex = -1;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]!;
    if (
      m.a.value === 1 &&
      m.a.unit === "each" &&
      (await isMoneyUnit(m.b.unit))
    ) {
      existingIndex = i;
      break;
    }
  }

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
