import type { ProductCategoryFeature } from "@cubby/schemas/product-category";

import {
  nestByParent,
  type TreeRow,
} from "~/app/_components/entity-list/manifest-tree";

interface CategoryTreeInput {
  id: string;
  parentId: string | null;
}

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
    row: TreeRow<(typeof categories)[number]>,
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
  const children = nestByParent(categories, (row) => row.parentId).map((row) =>
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
