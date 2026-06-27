import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { QueryTiming } from "~/lib/query-timing";
import type { TableStateReturn } from "../data-table/useTableState";
import {
  type ListQueryResponse,
  type TRPCQueryOptionsFn,
  usePaginatedTableCore,
} from "./usePaginatedTableCore";

interface UseInfiniteTableListOptions<TFilters> {
  queryOptions: TRPCQueryOptionsFn<TFilters>;
  buildFilters: (tableState: TableStateReturn) => TFilters;
  /** Shared table state, owned by the caller (one instance per page). */
  tableState: TableStateReturn;
  /** DB column name to group by (prepends primary ORDER BY on server) */
  groupBy?: string;
  /** Disable the query (hook still called but query doesn't fire) */
  enabled?: boolean;
}

export interface InfiniteScrollControls {
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

interface UseInfiniteTableListReturn<TData = unknown> {
  data: TData[];
  totalCount: number;
  isLoading: boolean;
  error: Error | null;
  tableState: TableStateReturn;
  timing: QueryTiming;
  infiniteScroll: InfiniteScrollControls;
  refreshControls: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
}

/**
 * Hook for managing infinite-scrolling table list queries with tRPC.
 *
 * Uses useInfiniteQuery to accumulate pages client-side.
 * Same interface as useTableList but adds infiniteScroll controls.
 */
export function useInfiniteTableList<TFilters, TData = unknown>({
  queryOptions,
  buildFilters,
  tableState,
  groupBy,
  enabled = true,
}: UseInfiniteTableListOptions<TFilters>): UseInfiniteTableListReturn<TData> {
  const { filters, sortParams, pagination, memoizedQueryOptions } =
    usePaginatedTableCore({
      queryOptions,
      buildFilters,
      tableState,
      groupBy,
    });

  // Get the base query options for page 0 to extract queryKey and queryFn shape
  const baseOptions = useMemo(
    () => ({
      ...memoizedQueryOptions,
      queryKey: [
        ...queryOptions({
          sort: sortParams,
          pagination: { pageIndex: 0, pageSize: pagination.pageSize },
          filters,
          ...(groupBy && { groupBy }),
        }).queryKey,
        "__infinite__",
      ],
    }),
    [
      memoizedQueryOptions,
      queryOptions,
      sortParams,
      pagination.pageSize,
      filters,
      groupBy,
    ],
  );

  const pageOptions = useMemo(
    () => (pageParam: number) =>
      queryOptions({
        sort: sortParams,
        pagination: { pageIndex: pageParam, pageSize: pagination.pageSize },
        filters,
        ...(groupBy && { groupBy }),
      }),
    [queryOptions, sortParams, pagination.pageSize, filters, groupBy],
  );

  const {
    data: infiniteData,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isRefetching,
    refetch,
  } = useInfiniteQuery({
    enabled,
    queryKey: baseOptions.queryKey,
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      const options = pageOptions(pageParam);
      // Call the queryFn from tRPC options
      return (await options.queryFn({
        queryKey: options.queryKey,
      })) as ListQueryResponse<TData>;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage: ListQueryResponse<TData>) => {
      const meta = lastPage.meta;
      if (!meta.totalCount || !meta.pageSize) return undefined;
      const pageIndex = meta.pageIndex;
      const loaded = (pageIndex + 1) * meta.pageSize;
      return loaded < meta.totalCount ? pageIndex + 1 : undefined;
    },
  }) as {
    data:
      | { pages: ListQueryResponse<TData>[]; pageParams: number[] }
      | undefined;
    isLoading: boolean;
    error: Error | null;
    fetchNextPage: () => void;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isRefetching: boolean;
    refetch: () => Promise<unknown>;
  };

  // Flatten all pages into a single array
  const data = useMemo(
    () => infiniteData?.pages.flatMap((p) => p.items) ?? [],
    [infiniteData],
  );

  const totalCount = infiniteData?.pages[0]?.meta?.totalCount ?? 0;

  return {
    data,
    totalCount,
    isLoading,
    error: error instanceof Error ? error : null,
    tableState,
    // Infinite scroll doesn't track per-query timing
    timing: { durationMs: null, isFresh: false },
    infiniteScroll: {
      fetchNextPage,
      hasNextPage: hasNextPage ?? false,
      isFetchingNextPage,
    },
    refreshControls: {
      onRefresh: async () => {
        await refetch();
      },
      isRefreshing: isRefetching && !isFetchingNextPage,
    },
  };
}
