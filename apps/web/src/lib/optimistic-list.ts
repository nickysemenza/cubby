/** Patch one row in a known list projection; never walks unrelated cache data. */
export function patchListItem<
  TItem extends { id: string },
  TPage extends { items: TItem[] },
>(
  current: TPage | undefined,
  id: string,
  patch: (item: TItem) => TItem,
): TPage | undefined {
  if (!current) return current;
  return {
    ...current,
    items: current.items.map((item) => (item.id === id ? patch(item) : item)),
  };
}

type CachedInfiniteList = { pages?: unknown[]; pageParams?: unknown[] };
type CachedList = { items?: { id: string }[]; data?: { id: string }[] };

/**
 * Patch one row across whatever shape a cache entry actually holds.
 *
 * `patchListItem` above assumes a `{ items }` page and is right to, because its
 * caller addresses one exact query key. A tag predicate does not have that
 * luxury: `[["wish"]]` matches every wish-tagged entry at once — plain list
 * pages, `InfiniteData` (`{ pages, pageParams }`) from an SSR loader, and the
 * detail query, since `descriptorMeta` stamps the entity root on all three. So
 * this walks like `removeDeletedIdsFromCache` in `useOptimisticDelete`: recurse
 * into pages, patch `items` or `data` when either is really an array, and hand
 * anything else back untouched rather than guessing.
 */
export function patchCachedListItem<TItem extends { id: string }>(
  old: unknown,
  id: string,
  patch: (item: TItem) => TItem,
): unknown {
  const patchRow = (item: unknown) =>
    item && typeof item === "object" && String((item as TItem).id) === id
      ? patch(item as TItem)
      : item;

  if (Array.isArray(old)) return old.map(patchRow);
  if (!old || typeof old !== "object") return old;

  const maybeInfinite = old as CachedInfiniteList;
  if (Array.isArray(maybeInfinite.pages)) {
    return {
      ...maybeInfinite,
      pages: maybeInfinite.pages.map((page) =>
        patchCachedListItem(page, id, patch),
      ),
    };
  }

  const list = old as CachedList;
  const source = Array.isArray(list.items)
    ? "items"
    : Array.isArray(list.data)
      ? "data"
      : null;
  if (source === null) return old;

  return { ...list, [source]: (list[source] ?? []).map(patchRow) };
}
