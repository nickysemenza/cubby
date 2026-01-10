import { useQuery } from "@tanstack/react-query";
import type {
  ColumnFiltersState,
  PaginationState,
} from "@tanstack/react-table";
import { useEffect, useMemo, useRef } from "react";
import type { QueryTiming } from "~/lib/query-timing";
import { useTableState } from "../data-table/useTableState";

interface TableStateOptions {
  initialSort?: string;
  initialFilter?: ColumnFiltersState;
  initialPagination?: PaginationState;
}

// Response shape from list queries (used for type narrowing)
interface ListQueryResponse<TData> {
  items: TData[];
  count: number;
  meta?: { totalCount?: number };
}

// tRPC queryOptions has complex internal typing that doesn't map cleanly to a simple function type.
// We use a permissive type here - the TFilters generic provides type safety for buildFilters.
type TRPCQueryOptionsFn<TFilters> = (params: {
  sort: { orderBy: string; direction: "asc" | "desc" };
  pagination: { pageIndex: number; pageSize: number };
  filters: TFilters;
  // biome-ignore lint/suspicious/noExplicitAny: intentional
}) => any;

export interface UseTableListOptions<TFilters> {
  // tRPC queryOptions function that takes list params and returns query options
  queryOptions: TRPCQueryOptionsFn<TFilters>;
  buildFilters: (tableState: ReturnType<typeof useTableState>) => TFilters;
  tableStateOptions?: TableStateOptions;
}

interface UseTableListReturn<TData = unknown> {
  data: TData[];
  totalCount: number;
  isLoading: boolean;
  error: Error | null;
  tableState: ReturnType<typeof useTableState>;
  timing: QueryTiming;
}

/**
 * Hook for managing table list queries with tRPC.
 *
 * Handles:
 * - Table state management (sorting, pagination, column filters)
 * - tRPC list query with automatic parameter passing
 * - Data extraction and error handling
 *
 * @example
 * ```tsx
 * const { data, totalCount, isLoading, error, tableState } = useTableList({
 *   queryOptions: api.product.list.queryOptions,
 *   buildFilters: (tableState) => ({
 *     nameFilter: tableState.getColumnFilter("name"),
 *     manufacturerFilter: tableState.getColumnFilter("manufacturer"),
 *     upcFilter: tableState.getColumnFilter("upc"),
 *   }),
 *   tableStateOptions: { initialSort: "createdAt" },
 * });
 *
 * const columns = [
 *   createNameColumn(columnHelper, "product"),
 *   // ...other columns
 * ];
 *
 * return (
 *   <RTable
 *     data={data}
 *     columns={columns}
 *     totalCount={totalCount}
 *     isLoading={isLoading}
 *     error={error}
 *     tableState={tableState}
 *   />
 * );
 * ```
 */
export function useTableList<TFilters, TData = unknown>({
  queryOptions,
  buildFilters,
  tableStateOptions,
}: UseTableListOptions<TFilters>): UseTableListReturn<TData> {
  const tableState = useTableState(tableStateOptions);

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
    }),
    [sortParams, pagination, filters],
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
  } = useQuery(memoizedQueryOptions) as {
    data: ListQueryResponse<TData> | undefined;
    isLoading: boolean;
    error: Error | null;
    isFetching: boolean;
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
    totalCount: response?.meta?.totalCount ?? response?.count ?? 0,
    isLoading,
    error: error instanceof Error ? error : null,
    tableState,
    timing: timingRef.current, // Use ref instead of state to avoid triggering rerenders
  };
}
