import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { compileEntityListInput } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
import { useEntityMetadata } from "~/entity/metadata";
import { getFeatureColor } from "~/entity/presentation/category-theme";
import { product } from "~/integrations/tanstack-query/generated/catalog/product.gen";

import {
  buildCategoryHierarchy,
  type CategoryHierarchyNode,
} from "./category-tree";

const categoryTreeInput = (queryClient: QueryClient) =>
  compileEntityListInput(
    queryClient,
    "productCategory",
    {},
    { defaultSort: { orderBy: "sortOrder", direction: "asc" } },
  );

/** The server-nested category tree, joined with each category's own products. */
export function useCategoryHierarchy() {
  const queryClient = useQueryClient();
  useEntityMetadata("productCategory");
  const input = useMemo(() => categoryTreeInput(queryClient), [queryClient]);
  const categories = useServerTree("productCategory", input);
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
