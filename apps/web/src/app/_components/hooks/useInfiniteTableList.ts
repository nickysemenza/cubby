import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  ColumnFiltersState,
  PaginationState,
} from "@tanstack/react-table";
import { useMemo } from "react";
import type { QueryTiming } from "~/lib/query-timing";
import { useTableState } from "../data-table/useTableState";

interface TableStateOptions {
  initialSort?: string;
  initialFilter?: ColumnFiltersState;
  initialPagination?: PaginationState;
}

// Response shape from list queries
interface ListQueryResponse<TData> {
  items: TData[];
  count: number;
  meta?: { pageIndex?: number; pageSize?: number; totalCount?: number };
}

type TRPCQueryOptionsFn<TFilters> = (params: {
  sort: { orderBy: string; direction: "asc" | "desc" };
  pagination: { pageIndex: number; pageSize: number };
  filters: TFilters;
  groupBy?: string;
  // biome-ignore lint/suspicious/noExplicitAny: intentional
}) => any;

export interface UseInfiniteTableListOptions<TFilters> {
  queryOptions: TRPCQueryOptionsFn<TFilters>;
  buildFilters: (tableState: ReturnType<typeof useTableState>) => TFilters;
  tableStateOptions?: TableStateOptions;
  /** DB column name to group by (prepends primary ORDER BY on server) */
  groupBy?: string;
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
  tableState: ReturnType<typeof useTableState>;
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
  tableStateOptions,
  groupBy,
}: UseInfiniteTableListOptions<TFilters>): UseInfiniteTableListReturn<TData> {
  const tableState = useTableState(tableStateOptions);

  const filters = useMemo(
    () => buildFilters(tableState),
    [buildFilters, tableState],
  );

  const sortParams = useMemo(() => tableState.getSortParams(), [tableState]);

  const { pagination } = tableState;

  // Get the base query options for page 0 to extract queryKey and queryFn shape
  const baseOptions = useMemo(
    () =>
      queryOptions({
        sort: sortParams,
        pagination: { pageIndex: 0, pageSize: pagination.pageSize },
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
    queryKey: [...baseOptions.queryKey, "__infinite__"],
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      // Build query options for the requested page
      const pageOptions = queryOptions({
        sort: sortParams,
        pagination: { pageIndex: pageParam, pageSize: pagination.pageSize },
        filters,
        ...(groupBy && { groupBy }),
      });
      // Call the queryFn from tRPC options
      return (await pageOptions.queryFn({
        queryKey: pageOptions.queryKey,
      })) as ListQueryResponse<TData>;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage: ListQueryResponse<TData>) => {
      const meta = lastPage.meta;
      if (!meta?.totalCount || !meta.pageSize) return undefined;
      const pageIndex = meta.pageIndex ?? 0;
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
