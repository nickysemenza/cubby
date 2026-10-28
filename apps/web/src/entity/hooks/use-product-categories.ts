import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityListFor, type EntityListParams } from "~/entity/entity-list";
import { useLoadAllPages } from "~/entity/hooks/use-all-entity-records";
import { flattenUniquePageItems } from "~/ui/hooks/infinite-page-utils";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";

const input = {
  filters: {},
  pagination: { pageIndex: 0, pageSize: 500 },
  sort: [{ orderBy: "sortOrder", direction: "asc" }],
} satisfies EntityListParams<"productCategory">;

/** A complete shared vocabulary: later pages must remain selectable, including
 * broad parents that a relevance-ranked first page might omit. */
export function useProductCategories(enabled = true) {
  const query = useInfiniteQuery({
    ...entityListFor("productCategory").infiniteQueryOptions(input),
    enabled,
  });
  useLoadAllPages(query, enabled);
  const categories = useMemo(
    () => flattenUniquePageItems(query.data?.pages),
    [query.data],
  );
  return {
    categories,
    isLoading: useHydratedLoading(
      !query.isError &&
        (query.isPending || query.hasNextPage || query.isFetchingNextPage),
    ),
    error: query.error,
    isComplete:
      !query.isPending &&
      !query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isError,
  };
}
