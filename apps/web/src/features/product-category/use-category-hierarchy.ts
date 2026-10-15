import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { compileEntityListInput } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
import { getFeatureColor } from "~/features/product/category-theme";
import { product } from "~/integrations/tanstack-query/generated/catalog.gen";

import {
  buildCategoryHierarchy,
  type CategoryHierarchyNode,
} from "./category-tree";

// The list's own sibling order; the server nests every level.
const CATEGORY_TREE_INPUT = compileEntityListInput(
  "productCategory",
  {},
  { defaultSort: { orderBy: "sortOrder", direction: "asc" } },
);

/** The server-nested category tree, joined with each category's own products. */
export function useCategoryHierarchy() {
  const categories = useServerTree("productCategory", CATEGORY_TREE_INPUT);
  const distribution = useQuery(product.categoryDistribution.queryOptions());
  const data = useMemo(() => {
    if (!categories.tree || !distribution.data) return null;
    const directCounts = new Map<string, number>();
    for (const { category, productCount } of distribution.data) {
      if (category) directCounts.set(category.id, productCount);
    }
    return buildCategoryHierarchy(categories.tree, directCounts);
  }, [categories.tree, distribution.data]);
  return {
    data,
    isLoading: categories.isLoading || distribution.isLoading,
    isError: Boolean(categories.error) || distribution.isError,
    error: categories.error ?? distribution.error,
    refetch: () => {
      categories.refetch();
      void distribution.refetch();
    },
  };
}

export const categoryNodeColor = (node: CategoryHierarchyNode): string =>
  getFeatureColor(node.feature);
