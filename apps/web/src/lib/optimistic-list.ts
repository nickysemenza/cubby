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
type CachedList<TItem extends { id: string }> = {
  items?: TItem[];
  data?: TItem[];
  count?: number;
  meta?: { totalCount?: number; [key: string]: unknown };
};

type ListTransform<TItem> = (items: TItem[]) => TItem[];

/** Walk the list envelopes stored by finite and infinite entity queries. */
function walkCachedListEnvelope<TItem extends { id: string }>(
  old: unknown,
  transform: ListTransform<TItem>,
): unknown {
  if (Array.isArray(old)) return transform(old as TItem[]);
  if (!old || typeof old !== "object") return old;

  const maybeInfinite = old as CachedInfiniteList;
  if (Array.isArray(maybeInfinite.pages)) {
    const pages = maybeInfinite.pages.map((page) =>
      walkCachedListEnvelope<TItem>(page, transform),
    );
    if (pages.every((page, index) => page === maybeInfinite.pages?.[index])) {
      return old;
    }
    return {
      ...maybeInfinite,
      pages,
    };
  }

  const list = old as CachedList<TItem>;
  const source = Array.isArray(list.items)
    ? "items"
    : Array.isArray(list.data)
      ? "data"
      : null;
  if (source === null) return old;

  const current = list[source] ?? [];
  const next = transform(current);
  if (next === current) return old;

  const removed = Math.max(0, current.length - next.length);
  return {
    ...list,
    [source]: next,
    ...(removed > 0 && typeof list.count === "number"
      ? { count: Math.max(0, list.count - removed) }
      : null),
    ...(removed > 0 && list.meta && typeof list.meta.totalCount === "number"
      ? {
          meta: {
            ...list.meta,
            totalCount: Math.max(0, list.meta.totalCount - removed),
          },
        }
      : null),
  };
}

/**
 * Patch one row across whatever shape a cache entry actually holds.
 *
 * `patchListItem` above assumes a `{ items }` page and is right to, because its
 * caller addresses one exact query key. A tag predicate does not have that
 * luxury: `[["wish"]]` matches every wish-tagged entry at once — plain list
 * pages, `InfiniteData` (`{ pages, pageParams }`) from an SSR loader, and the
 * detail query, since `descriptorMeta` stamps the entity root on all three. So
 * the shared envelope walker recurses into pages, patches `items` or `data`
 * when either is really an array, and hands anything else back untouched
 * rather than guessing.
 */
export function patchCachedListItem<TItem extends { id: string }>(
  old: unknown,
  id: string,
  patch: (item: TItem) => TItem,
): unknown {
  return walkCachedListEnvelope<TItem>(old, (items) => {
    let changed = false;
    const next = items.map((item) => {
      if (!item || typeof item !== "object" || String(item.id) !== id) {
        return item;
      }
      changed = true;
      return patch(item);
    });
    return changed ? next : items;
  });
}

/** Remove rows from any supported list envelope and keep totals in sync. */
export function removeCachedListItems(
  old: unknown,
  deletedIds: ReadonlySet<string>,
): unknown {
  return walkCachedListEnvelope<{ id: string }>(old, (items) => {
    const next = items.filter(
      (item) =>
        !(item && typeof item === "object" && deletedIds.has(String(item.id))),
    );
    return next.length === items.length ? items : next;
  });
}
