import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { entityListFor } from "~/entities/entity-list.functions";

/** A complete shared vocabulary: later pages must remain selectable, including
 * broad parents that a relevance-ranked first page might omit. */
export function useProductCategories() {
  const query = useInfiniteQuery(
    entityListFor("productCategory").infiniteQueryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 500 },
      sort: [{ orderBy: "sortOrder", direction: "asc" }],
    }),
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isError]);
  return {
    categories: query.data?.pages.flatMap((page) => page.items) ?? [],
    isLoading: query.isPending || query.isFetchingNextPage,
  };
}
