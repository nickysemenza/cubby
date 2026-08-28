import { z } from "zod";

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

type ListIdentity = { id: string };

const cachedEnvelopeSchema = z
  .object({
    pages: z.array(z.unknown()).optional(),
    pageParams: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    data: z.array(z.unknown()).optional(),
    count: z.unknown().optional(),
    meta: z.unknown().optional(),
  })
  .passthrough();
const listIdentitySchema = z.object({ id: z.string() });
const listMetadataSchema = z
  .object({ totalCount: z.number().optional() })
  .passthrough();

type CachedEnvelope = z.infer<typeof cachedEnvelopeSchema>;
type CachePrimitive =
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined;
type CachedSnapshotResult<TSnapshot, TItem extends ListIdentity> =
  | CachePrimitive
  | CachedEnvelope
  | TItem[]
  | TSnapshot;
type ListTransform<TItem extends ListIdentity> = (item: TItem) => TItem | null;

function isListItem<TItem extends ListIdentity, TValue>(
  value: TValue,
): value is TValue & TItem {
  return listIdentitySchema.safeParse(value).success;
}

function transformList<TItem extends ListIdentity, TValue>(
  values: TValue[],
  transform: ListTransform<TItem>,
): TValue[] | Array<TValue | TItem> {
  let changed = false;
  const next: Array<TValue | TItem> = [];
  for (const value of values) {
    if (!isListItem<TItem, TValue>(value)) {
      next.push(value);
      continue;
    }
    const replacement = transform(value);
    if (replacement === null) {
      changed = true;
      continue;
    }
    if (replacement !== value) changed = true;
    next.push(replacement);
  }
  return changed ? next : values;
}

/** Walk the list envelopes stored by finite and infinite entity queries. */
function walkCachedListEnvelope<
  TItem extends ListIdentity,
  TSnapshot = unknown,
>(
  old: TSnapshot,
  transform: ListTransform<TItem>,
): CachedSnapshotResult<TSnapshot, TItem> {
  const parsed = cachedEnvelopeSchema.safeParse(old);
  if (!parsed.success) {
    if (!Array.isArray(old)) return old;
    return transformList(old, transform);
  }

  const envelope = parsed.data;
  if (Array.isArray(envelope.pages)) {
    const pages = envelope.pages.map((page) =>
      walkCachedListEnvelope<TItem, typeof page>(page, transform),
    );
    if (pages.every((page, index) => page === envelope.pages?.[index])) {
      return old;
    }
    return {
      ...envelope,
      pages,
    };
  }

  const source = Array.isArray(envelope.items)
    ? "items"
    : Array.isArray(envelope.data)
      ? "data"
      : null;
  if (source === null) return old;

  const current = envelope[source] ?? [];
  const next = transformList(current, transform);
  if (next === current) return old;

  const removed = Math.max(0, current.length - next.length);
  const result = {
    ...envelope,
    [source]: next,
  };
  const count = z.number().safeParse(envelope.count);
  if (removed > 0 && count.success)
    result.count = Math.max(0, count.data - removed);
  const meta = listMetadataSchema.safeParse(envelope.meta);
  if (removed > 0 && meta.success && meta.data.totalCount !== undefined)
    result.meta = {
      ...meta.data,
      totalCount: Math.max(0, meta.data.totalCount - removed),
    };
  return result;
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
export function patchCachedListItem<
  TItem extends ListIdentity,
  TSnapshot = unknown,
>(
  old: TSnapshot,
  id: string,
  patch: (item: TItem) => TItem,
): CachedSnapshotResult<TSnapshot, TItem> {
  return walkCachedListEnvelope<TItem, TSnapshot>(old, (item) =>
    item.id === id ? patch(item) : item,
  );
}

/** Remove rows from any supported list envelope and keep totals in sync. */
export function removeCachedListItems<TSnapshot = unknown>(
  old: TSnapshot,
  deletedIds: ReadonlySet<string>,
): CachedSnapshotResult<TSnapshot, ListIdentity> {
  return walkCachedListEnvelope<ListIdentity, TSnapshot>(old, (item) =>
    deletedIds.has(item.id) ? null : item,
  );
}
