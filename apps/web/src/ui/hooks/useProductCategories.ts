import { productCategoryOut } from "@cubby/schemas/product-category";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityListBaseFor, type EntityListParams } from "~/entity/entity-list";

import { flattenUniquePageItems } from "./infinite-page-utils";
import { useLoadAllPages } from "./useAllEntityRecords";
import { useHydratedLoading } from "./useHydrated";

const vocabulary = productCategoryOut
  .pick({
    id: true,
    name: true,
    parentId: true,
    aliases: true,
    description: true,
    path: true,
    feature: true,
  })
  .array();
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
    ),
  );
  useLoadAllPages(query);
  const categories = useMemo(
    () => vocabulary.parse(flattenUniquePageItems(query.data?.pages)),
    [query.data],
  );
  return {
    categories,
    isLoading: useHydratedLoading(
      query.isPending || query.hasNextPage || query.isFetchingNextPage,
    ),
  };
}
