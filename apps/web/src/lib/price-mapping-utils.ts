import type { Amount } from "@cubby/schemas/codec";
import { wasm } from "~/lib/wasm";

/**
 * Checks if a unit represents money/currency using WASM.
 */
export const isMoneyUnit = (unit: string): boolean => {
  try {
    return wasm.amount_kind({ value: 1, unit }) === "money";
  } catch {
    return false;
  }
};

const isSingleEach = (a: Amount): boolean => a.value === 1 && a.unit === "each";

/**
 * A canonical price mapping is "1 each <-> $X" (in either direction).
 *
 * This is the ONE form that duplicates the `product.price` column (per-each
 * price), so it's forbidden in unit mappings and migrated to the column. Other
 * money mappings — per-measure prices like "1 quart = $4" for generic
 * ingredients that have no discrete "each" — are allowed: the scalar column
 * can't express them, so they legitimately live as conversion edges and feed
 * recipe costing directly.
 */
export const isCanonicalPriceMapping = (mapping: {
  a: Amount;
  b: Amount;
}): boolean =>
  (isSingleEach(mapping.a) && isMoneyUnit(mapping.b.unit)) ||
  (isSingleEach(mapping.b) && isMoneyUnit(mapping.a.unit));

/**
 * Truncate a monetary value to 2 decimal places (cents precision).
 * Uses rounding to avoid floating-point errors.
 */
export const truncateToTwoDecimals = (value: number): number => {
  return Math.round(value * 100) / 100;
};

/**
 * Compute the valuation (total value) for an inventory entry.
 * Simple multiplication of quantity by unit price.
 * Truncates to 2 decimal places (cents precision).
 */
export const computeInventoryValuation = (
  amountValue: number,
  productPrice: number | null,
): number | null => {
  if (productPrice === null) return null;
  return truncateToTwoDecimals(amountValue * productPrice);
};
