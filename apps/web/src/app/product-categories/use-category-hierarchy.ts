import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useProductCategories } from "~/app/_components/hooks/useProductCategories";
import { getFeatureColor } from "~/app/_components/products/category-theme";
import { product } from "~/app/products/product.functions";

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
