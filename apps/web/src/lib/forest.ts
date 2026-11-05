/** The project fields read by the project forest fold. */
export interface ForestNode {
  id: string;
  parentProjectId: string | null;
}

/** Group parent-linked rows in input order, promoting missing-parent rows. */
export function groupForest<T, K>(
  items: readonly T[],
  idOf: (item: T) => K,
  parentIdOf: (item: T) => K | null,
) {
  const ids = new Set(items.map(idOf));
  const roots: T[] = [];
  const childrenByParent = new Map<K, T[]>();
  for (const item of items) {
    const parentId = parentIdOf(item);
    if (parentId == null || !ids.has(parentId)) {
      roots.push(item);
    } else {
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(item);
      else childrenByParent.set(parentId, [item]);
    }
  }
  return { roots, childrenByParent };
}
