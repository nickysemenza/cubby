import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { entityListFor } from "~/entities/entity-list.functions";

import { flattenUniquePageItems } from "../hooks/infinite-page-utils";

export function useAllInventoryItems() {
  const firstPageOptions = entityListFor("inventory").infiniteQueryOptions({
    sort: { orderBy: "createdAt", direction: "desc" },
    pagination: { pageIndex: 0, pageSize: MAX_PAGE_SIZE },
    filters: {},
  });
  const query = useInfiniteQuery(firstPageOptions);

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage({ cancelRefetch: false });
    }
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const items = useMemo(
    () => flattenUniquePageItems(query.data?.pages),
    [query.data],
  );

  return {
    ...query,
    items,
    isLoadingAll:
      query.isLoading || query.isFetchingNextPage || query.hasNextPage,
  };
}
