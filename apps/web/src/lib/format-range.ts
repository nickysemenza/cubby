import { formatCurrency } from "~/lib/utils";

// Range-aware display helpers for amounts that carry a min–max upper bound
// ("2–3 cups" → "$2.00 – $3.00"). Every formatter applies the `upper > lower`
// guard so a point value (or a degenerate equal range) never renders "X – X".
// The en-dash with spaces matches the WASM `format_amount` style.

const RANGE_DASH = " – ";

const isRange = (lower: number, upper: number | undefined): upper is number =>
  upper != null && upper > lower;

/** "$3.20" or "$3.20 – $4.10". */
export const formatCurrencyRange = (
  lower: number,
  upper?: number,
  decimals = 2,
): string =>
  isRange(lower, upper)
    ? `${formatCurrency(lower, decimals)}${RANGE_DASH}${formatCurrency(upper, decimals)}`
    : formatCurrency(lower, decimals);

/** Generic numeric range with a caller-supplied formatter (kcal, grams, …). */
export const formatNumberRange = (
  lower: number,
  upper: number | undefined,
  fmt: (n: number) => string,
): string =>
  isRange(lower, upper)
    ? `${fmt(lower)}${RANGE_DASH}${fmt(upper)}`
    : fmt(lower);

/**
 * Midpoint of a range, for use as a single deterministic sort/geometry key.
 * A point value (no upper) returns itself, so ranged and flat values interleave
 * consistently.
 */
export const rangeMidpoint = (lower: number, upper?: number): number =>
  upper != null ? (lower + upper) / 2 : lower;
