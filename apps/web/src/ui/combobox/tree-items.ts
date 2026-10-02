import type { ComboboxItem } from "./combobox-types";

export interface TreePickerItemsOptions<T> {
  idOf: (node: T) => string;
  parentIdOf: (node: T) => string | null;
  labelOf: (node: T) => string;
  /** Overrides the default ancestor-path detail line for a non-root node.
   * The default already renders `Apparel > Outerwear` for a leaf, so most
   * callers (product classification, any other parent-linked entity) never
   * pass this. */
  detailOf?: (node: T, ancestorLabels: readonly string[]) => string | null;
  /** Root ordering; default is alphabetical by label, stable for ties. */
  rootOrder?: (a: T, b: T) => number;
}

/**
 * Flattens a parent-linked tree into `ComboboxItem[]`, depth-first, with
 * `presentation.group` naming the root each node descends from and
 * `presentation.depth` its distance from that root — the shared shape
 * `EntityPicker`/`FilterableCombobox` render as a grouped, indented list
 * (the "grouped-list + breadcrumb tree picker" decision, not
 * expand/collapse). Children keep the caller's own array order (assumed
 * already sensible, e.g. a `sortOrder` column) — only the roots are
 * reordered, alphabetically unless `rootOrder` is given.
 *
 * A node whose declared parent is absent from `nodes` (a stale or foreign
 * id) is treated as its own root rather than dropped — every node in
 * `nodes` appears exactly once in the result.
 */
export function treePickerItems<T>(
  nodes: readonly T[],
  { idOf, parentIdOf, labelOf, detailOf, rootOrder }: TreePickerItemsOptions<T>,
): ComboboxItem[] {
  const byId = new Map(nodes.map((node) => [idOf(node), node]));
  const childrenOf = new Map<string | null, T[]>();
  for (const node of nodes) {
    const parentId = parentIdOf(node);
    const key = parentId != null && byId.has(parentId) ? parentId : null;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(node);
    else childrenOf.set(key, [node]);
  }

  const roots = [...(childrenOf.get(null) ?? [])].sort(
    rootOrder ?? ((a, b) => labelOf(a).localeCompare(labelOf(b))),
  );

  const items: ComboboxItem[] = [];
  const walk = (
    node: T,
    rootId: string,
    rootLabel: string,
    rootOrderIndex: number,
    depth: number,
    ancestorLabels: readonly string[],
  ) => {
    items.push({
      id: idOf(node),
      // The full path is the item's value label: it is what the closed
      // control shows once this node is selected and what typing filters
      // on. The row itself renders the node's own label via `rowLabel`,
      // since the group header and indent already carry the ancestry.
      name: [...ancestorLabels, labelOf(node)].join(" / "),
      detail:
        depth === 0
          ? undefined
          : detailOf
            ? (detailOf(node, ancestorLabels) ?? undefined)
            : ancestorLabels.join(" > "),
      presentation: {
        group: { id: rootId, label: rootLabel, order: rootOrderIndex },
        depth,
        rowLabel: labelOf(node),
      },
    });
    for (const child of childrenOf.get(idOf(node)) ?? []) {
      walk(child, rootId, rootLabel, rootOrderIndex, depth + 1, [
        ...ancestorLabels,
        labelOf(node),
      ]);
    }
  };
  roots.forEach((root, index) => {
    walk(root, idOf(root), labelOf(root), index, 0, []);
  });
  return items;
}
