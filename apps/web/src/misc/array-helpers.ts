/**
 * Flattens a nested array type by extracting the inner type.
 * @template T - The type to flatten
 */
export type Flatten<T> = T extends Array<infer U> ? U : T;

/**
 * Max ids per batched `getManyByIDs` query. Pair with es-toolkit's `chunk` to
 * bound database and serialization work per query; sort the input first if you
 * want stable cache keys.
 */
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
