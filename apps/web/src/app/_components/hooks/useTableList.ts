"use client";

import { useQuery } from "@tanstack/react-query";
import { useTableState } from "../data-table/useTableState";
import type { PaginationState } from "@tanstack/react-table";
import type { ColumnFiltersState } from "@tanstack/react-table";

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

  const filters = buildFilters(tableState);

  const {
    data: response,
    isLoading,
    error,
  } = useQuery(
    queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters,
    }),
  ) as {
    data: ListQueryResponse<TData> | undefined;
    isLoading: boolean;
    error: Error | null;
  };

  // useQuery returns error as Error | null when throwOnError is false (default)
  return {
    data: response?.items ?? [],
    totalCount: response?.meta?.totalCount ?? response?.count ?? 0,
    isLoading,
    error: error instanceof Error ? error : null,
    tableState,
  };
}
