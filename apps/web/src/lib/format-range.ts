// Range-aware display helpers for amounts that carry a min–max upper bound.
// A point value (or a degenerate equal range) never renders "X–X".

const RANGE_DASH = "–";

const isRange = (lower: number, upper: number | undefined): upper is number =>
  upper != null && upper > lower;

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
