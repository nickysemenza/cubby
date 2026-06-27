import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { QueryTiming } from "~/lib/query-timing";
import type { TableStateReturn } from "../data-table/useTableState";

// Response shape from list queries (used for type narrowing)
interface ListQueryResponse<TData> {
  items: TData[];
  meta: { totalCount: number };
}

// tRPC queryOptions has complex internal typing that doesn't map cleanly to a simple function type.
// We use a permissive type here - the TFilters generic provides type safety for buildFilters.
type TRPCQueryOptionsFn<TFilters> = (params: {
  sort: { orderBy: string; direction: "asc" | "desc" };
  pagination: { pageIndex: number; pageSize: number };
  filters: TFilters;
  groupBy?: string;
  // biome-ignore lint/suspicious/noExplicitAny: intentional
}) => any;

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
  // Memoize filters to prevent recreating on every render
  const filters = useMemo(
    () => buildFilters(tableState),
    [buildFilters, tableState],
  );

  // Memoize sortParams to prevent recreating on every render
  const sortParams = useMemo(() => tableState.getSortParams(), [tableState]);

  const { pagination } = tableState;

  // Memoize query params to prevent recreating on every render - CRITICAL for performance
  const queryParams = useMemo(
    () => ({
      sort: sortParams,
      pagination,
      filters,
      ...(groupBy && { groupBy }),
    }),
    [sortParams, pagination, filters, groupBy],
  );

  // CRITICAL: Memoize the result of calling queryOptions(queryParams)
  // Otherwise React Query sees a new options object on every render and refetches!
  const memoizedQueryOptions = useMemo(
    () => queryOptions(queryParams),
    [queryOptions, queryParams],
  );

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

  // Track query timing
  const startTimeRef = useRef<number | null>(null);
  const timingRef = useRef<QueryTiming>({
    durationMs: null,
    isFresh: false,
  });

  // Start timing when fetch begins - use ref instead of state to avoid rerenders
  useEffect(() => {
    if (isFetching && startTimeRef.current === null) {
      startTimeRef.current = performance.now();
    }
  }, [isFetching]);

  // Calculate duration when fetch completes - use ref instead of state
  useEffect(() => {
    if (!isFetching && startTimeRef.current !== null) {
      const duration = Math.round(performance.now() - startTimeRef.current);
      timingRef.current = { durationMs: duration, isFresh: true };
      startTimeRef.current = null;
    }
  }, [isFetching]);

  const dataArray = response?.items ?? [];

  // useQuery returns error as Error | null when throwOnError is false (default)
  return {
    data: dataArray,
    totalCount: response?.meta.totalCount ?? 0,
    isLoading,
    isPlaceholderData,
    error: error instanceof Error ? error : null,
    tableState,
    timing: timingRef.current, // Use ref instead of state to avoid triggering rerenders
    refreshControls: {
      onRefresh: async () => {
        await refetch();
      },
      isRefreshing: isRefetching,
    },
  };
}
