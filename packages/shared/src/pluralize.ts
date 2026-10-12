import pluralize from "pluralize";

// Matches apps/web `formatCount` (en-US grouping, no fraction digits).
const countFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

/**
 * A count plus its correctly pluralized noun, e.g. `countLabel(1, "planting")`
 * → "1 planting", `countLabel(3, "planting")` → "3 plantings". Pass
 * `{ formatted: true }` to render the count with thousands separators
 * (e.g. "1,240 plantings").
 */
export function countLabel(
  count: number,
  word: string,
  opts?: { formatted?: boolean },
): string {
  const n = opts?.formatted ? countFormat.format(count) : String(count);
  return `${n} ${pluralize(word, count)}`;
}
