import { productCategoryOut } from "@cubby/schemas/product-category";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityListBaseFor, type EntityListParams } from "~/entity/entity-list";
import { flattenUniquePageItems } from "~/ui/hooks/infinite-page-utils";
import { useLoadAllPages } from "~/ui/hooks/use-all-entity-records";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";

const vocabulary = productCategoryOut.pick({
  id: true,
  name: true,
  parentId: true,
  aliases: true,
  description: true,
  path: true,
  feature: true,
});
const groups = ["relations"] as const;
const input = {
  filters: {},
  pagination: { pageIndex: 0, pageSize: 500 },
  sort: [{ orderBy: "sortOrder", direction: "asc" }],
} satisfies EntityListParams<"productCategory">;

/** A complete shared vocabulary: later pages must remain selectable, including
 * broad parents that a relevance-ranked first page might omit. */
export function useProductCategories() {
  const query = useInfiniteQuery(
    entityListBaseFor("productCategory").projectedInfiniteQueryOptions(
      input,
      groups,
      vocabulary,
    ),
  );
  useLoadAllPages(query);
  const categories = useMemo(
    () => flattenUniquePageItems(query.data?.pages),
    [query.data],
  );
  return {
    categories,
    isLoading: useHydratedLoading(
      query.isPending || query.hasNextPage || query.isFetchingNextPage,
    ),
  };
}
