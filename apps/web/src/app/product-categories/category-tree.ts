import type { ProductCategoryFeature } from "@cubby/schemas/product-category";

interface CategoryTreeInput {
  id: string;
  parentId: string | null;
}

export type CategoryTreeRow<T extends CategoryTreeInput> = T & {
  subRows?: CategoryTreeRow<T>[];
};

/**
 * Nests flat category rows under their parents, keeping the input's sibling
 * order. A row whose parent is not among `rows` (a search match, or a parent
 * on a page not yet loaded) becomes a root, so filtering never hides a match.
 */
export function nestProductCategories<T extends CategoryTreeInput>(
  rows: readonly T[],
): CategoryTreeRow<T>[] {
  const nodes = new Map<string, CategoryTreeRow<T>>(
    rows.map((row) => [row.id, { ...row }]),
  );
  const roots: CategoryTreeRow<T>[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parent =
      row.parentId && row.parentId !== row.id
        ? nodes.get(row.parentId)
        : undefined;
    if (parent) (parent.subRows ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

export const productCategorySubRows = <T extends CategoryTreeInput>(
  row: CategoryTreeRow<T>,
) => row.subRows;

export interface CategoryHierarchyNode {
  id: string;
  name: string;
  /** The closest feature binding on the path, as Product reads inherit it. */
  feature: ProductCategoryFeature | null;
  /** Products assigned directly to this category. */
  directCount: number;
  /** Products in this category and every descendant. */
  totalCount: number;
  children?: CategoryHierarchyNode[];
}

export const CATEGORY_HIERARCHY_ROOT_ID = "__all__";

/**
 * One synthetic "All categories" root over the real roots, with each node's
 * direct product count rolled up into its ancestors' totals.
 */
export function buildCategoryHierarchy(
  categories: readonly (CategoryTreeInput & {
    name: string;
    feature: ProductCategoryFeature | null;
  })[],
  directCounts: ReadonlyMap<string, number>,
): CategoryHierarchyNode {
  const toNode = (
    row: CategoryTreeRow<(typeof categories)[number]>,
    inherited: ProductCategoryFeature | null,
  ): CategoryHierarchyNode => {
    const feature = row.feature ?? inherited;
    const children = row.subRows?.map((child) => toNode(child, feature));
    const directCount = directCounts.get(row.id) ?? 0;
    const node: CategoryHierarchyNode = {
      id: row.id,
      name: row.name,
      feature,
      directCount,
      totalCount:
        directCount +
        (children?.reduce((sum, child) => sum + child.totalCount, 0) ?? 0),
    };
    if (children) node.children = children;
    return node;
  };
  const children = nestProductCategories(categories).map((row) =>
    toNode(row, null),
  );
  return {
    id: CATEGORY_HIERARCHY_ROOT_ID,
    name: "All categories",
    feature: null,
    directCount: 0,
    totalCount: children.reduce((sum, child) => sum + child.totalCount, 0),
    children,
  };
}
