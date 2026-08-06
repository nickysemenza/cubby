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
