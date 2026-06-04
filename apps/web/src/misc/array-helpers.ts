/**
 * Flattens a nested array type by extracting the inner type.
 * @template T - The type to flatten
 */
export type Flatten<T> = T extends Array<infer U> ? U : T;

/**
 * Removes duplicate values from an array using Set.
 * @template T - The type of array elements
 * @param arr - The array to deduplicate
 * @returns A new array with duplicates removed
 */
export const dedupe = <T>(arr: T[]): T[] => Array.from(new Set(arr));

/**
 * Splits an array into consecutive chunks of at most `size`. Used to keep
 * batched tRPC queries (e.g. `getManyByIDs`) under the batch link's
 * `maxURLLength` — each chunk becomes one query the link can split across
 * requests. Sort the input first if you want stable cache keys.
 */
export const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  if (size <= 0) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Max ids per batched `getManyByIDs` query (UUIDs → well under maxURLLength). */
export const ID_CHUNK_SIZE = 50;

/**
 * Sums a numeric value across items, grouped by a derived key.
 * Items whose key is null/undefined are skipped; null/undefined values count as 0.
 * Pre-filter the input when you want to exclude zero/empty values entirely.
 * @returns A Map of key → summed total, in first-seen key order.
 */
export const sumByKey = <T, K>(
  items: Iterable<T>,
  keyFn: (item: T) => K | null | undefined,
  valueFn: (item: T) => number | null | undefined,
): Map<K, number> => {
  const totals = new Map<K, number>();
  for (const item of items) {
    const key = keyFn(item);
    if (key == null) continue;
    totals.set(key, (totals.get(key) ?? 0) + (valueFn(item) ?? 0));
  }
  return totals;
};
