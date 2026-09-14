import pluralize from "pluralize";

import { formatCount } from "./utils";

/** Pluralize `word` for `count` (e.g. `pluralWord("planting", 3)` → "plantings"). */
export function pluralWord(word: string, count: number): string {
  return pluralize(word, count);
}

/**
 * A count plus its correctly pluralized noun, e.g. `countLabel(1, "planting")`
 * → "1 planting", `countLabel(3, "planting")` → "3 plantings". Pass
 * `{ formatted: true }` to render the count with thousands separators via
 * `formatCount` (e.g. "1,240 plantings").
 */
export function countLabel(
  count: number,
  word: string,
  opts?: { formatted?: boolean },
): string {
  const n = opts?.formatted ? formatCount(count) : String(count);
  return `${n} ${pluralWord(word, count)}`;
}
