import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { QueryTiming } from "~/lib/query-timing";
import type { TableStateReturn } from "../data-table/useTableState";
import {
  type ListQueryResponse,
  type TRPCQueryOptionsFn,
  usePaginatedTableCore,
  useQueryTiming,
} from "./usePaginatedTableCore";

export interface UseTableListOptions<TFilters> {
  // tRPC queryOptions function that takes list params and returns query options
  queryOptions: TRPCQueryOptionsFn<TFilters>;
  buildFilters: (tableState: TableStateReturn) => TFilters;
  /** Shared table state, owned by the caller (one instance per page). */
  tableState: TableStateReturn;
  /** DB column name to group by (prepends primary ORDER BY on server) */
  groupBy?: string;
  /** Disable the query (hook still called but query doesn't fire) */
  enabled?: boolean;
}

interface UseTableListReturn<TData = unknown> {
  data: TData[];
  totalCount: number;
  /** Server-computed full-filtered-set column sums (footer totals). */
  sums?: Record<string, number>;
  isLoading: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
  tableState: TableStateReturn;
  timing: QueryTiming;
  refreshControls: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
}

/**
 * Hook for managing table list queries with tRPC.
 *
 * Handles:
 * - Table state management (sorting, pagination, column filters)
 * - tRPC list query with automatic parameter passing
 * - Data extraction and error handling
 */
export function useTableList<TFilters, TData = unknown>({
  queryOptions,
  buildFilters,
  tableState,
  groupBy,
  enabled = true,
}: UseTableListOptions<TFilters>): UseTableListReturn<TData> {
  const { memoizedQueryOptions } = usePaginatedTableCore({
    queryOptions,
    buildFilters,
    tableState,
    groupBy,
  });

  const {
    data: response,
    isLoading,
    error,
    isFetching,
    isRefetching,
    isPlaceholderData,
    refetch,
  } = useQuery({
    ...memoizedQueryOptions,
    enabled,
    placeholderData: keepPreviousData,
  }) as {
    data: ListQueryResponse<TData> | undefined;
    isLoading: boolean;
    error: Error | null;
    isFetching: boolean;
    isRefetching: boolean;
    isPlaceholderData: boolean;
    refetch: () => Promise<unknown>;
  };

  const timing = useQueryTiming(isFetching);

  const dataArray = response?.items ?? [];

  // useQuery returns error as Error | null when throwOnError is false (default)
  return {
    data: dataArray,
    totalCount: response?.meta.totalCount ?? 0,
    sums: response?.meta.sums,
    isLoading,
    isPlaceholderData,
    error: error instanceof Error ? error : null,
    tableState,
    timing,
    refreshControls: {
      onRefresh: async () => {
        await refetch();
      },
      isRefreshing: isRefetching,
    },
  };
}
