import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getFeatureColor } from "~/features/products/category-theme";
import { product } from "~/integrations/tanstack-query/generated/catalog.gen";
import { useProductCategories } from "~/ui/hooks/useProductCategories";

import {
  buildCategoryHierarchy,
  type CategoryHierarchyNode,
} from "./category-tree";

/** Every category, joined with how many products sit directly in each. */
export function useCategoryHierarchy() {
  const { categories, isLoading: categoriesLoading } = useProductCategories();
  const distribution = useQuery(product.categoryDistribution.queryOptions());
  const data = useMemo(() => {
    if (categoriesLoading || !distribution.data) return null;
    const directCounts = new Map<string, number>();
    for (const { category, productCount } of distribution.data) {
      if (category) directCounts.set(category.id, productCount);
    }
    return buildCategoryHierarchy(categories, directCounts);
  }, [categories, categoriesLoading, distribution.data]);
  return {
    data,
    isLoading: categoriesLoading || distribution.isLoading,
    isError: distribution.isError,
    error: distribution.error,
    refetch: distribution.refetch,
  };
}

export const categoryNodeColor = (node: CategoryHierarchyNode): string =>
  getFeatureColor(node.feature);
