import type { RecipeImportStatus } from "../recipe-import-card";

export type NotionPreviewFilter =
  | "all"
  | "new"
  | "will-update"
  | "unchanged"
  | "needs-formatting";

type PreviewLike = {
  pageId: string;
  recipe: { meta: { title: string } };
  status: RecipeImportStatus;
};

/** Filter before cards mount: RecipeImportCard performs WASM parsing and a query. */
export function filterNotionPreview<T extends PreviewLike>(
  items: readonly T[],
  search: string,
  filter: NotionPreviewFilter,
): T[] {
  const query = search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (filter === "all" || item.status === filter) &&
      (query.length === 0 ||
        item.recipe.meta.title.toLocaleLowerCase().includes(query)),
  );
}

export function updateVisibleSelection<T extends { pageId: string }>(
  selected: ReadonlySet<string>,
  visibleActionable: readonly T[],
): Set<string> {
  const next = new Set(selected);
  const allSelected = visibleActionable.every((item) => next.has(item.pageId));
  for (const item of visibleActionable) {
    if (allSelected) next.delete(item.pageId);
    else next.add(item.pageId);
  }
  return next;
}
