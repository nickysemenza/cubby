/** A list row must keep the same identity across pages, filters, and sorts. */
export interface IdentifiedListRow {
  id: string;
}

/**
 * Flatten paginated rows while preserving the first occurrence of each id.
 *
 * Deterministic server ordering is the primary pagination guarantee. This is
 * the client-side backstop for an overlapping/refetched page: a repeated row
 * must never be rendered or selected twice.
 */
export function flattenUniquePageItems<T extends IdentifiedListRow>(
  pages: ReadonlyArray<{ items: readonly T[] }> | undefined,
): T[] {
  if (!pages) return [];

  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}
