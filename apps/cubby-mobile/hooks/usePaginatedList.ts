import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

type PaginatedResult<T> = {
  items: T[];
  meta: { pageIndex: number; pageSize: number; totalCount: number };
};

/**
 * Wraps a tRPC list query with useInfiniteQuery for infinite scroll + pull-to-refresh.
 *
 * Accepts a queryFn that calls the trpcClient directly (not the options proxy).
 */
export function usePaginatedList<T = Record<string, unknown>>(opts: {
  queryFn: (params: {
    filters: Record<string, unknown>;
    pagination: { pageIndex: number; pageSize: number };
  }) => Promise<PaginatedResult<T>>;
  filters: Record<string, unknown>;
  pageSize?: number;
  queryKey: readonly unknown[];
}) {
  const { queryFn, filters, pageSize = 25, queryKey } = opts;
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  const query = useInfiniteQuery({
    queryKey: [...queryKey, filters, pageSize],
    queryFn: async ({ pageParam = 0 }) => {
      return await queryFn({
        filters,
        pagination: { pageIndex: pageParam as number, pageSize },
      });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      const loaded = ((lastPageParam as number) + 1) * pageSize;
      if (loaded >= lastPage.meta.totalCount) return undefined;
      return (lastPageParam as number) + 1;
    },
  });

  const data = query.data?.pages.flatMap((p) => p.items) ?? [];
  const totalCount = query.data?.pages[0]?.meta.totalCount ?? 0;

  const onRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    await query.refetch();
    setIsManualRefreshing(false);
  }, [query]);

  return {
    data,
    totalCount,
    isLoading: query.isLoading,
    error: query.error,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isRefreshing: isManualRefreshing,
    onRefresh,
  };
}
