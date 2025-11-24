"use client";

import { useQuery } from "@tanstack/react-query";
import { useTableState } from "../data-table/useTableState";
import { type PaginationState } from "@tanstack/react-table";
import { type ColumnFiltersState } from "@tanstack/react-table";

interface TableStateOptions {
  initialSort?: string;
  initialFilter?: ColumnFiltersState;
  initialPagination?: PaginationState;
}

export interface UseTableListOptions<TFilters> {
  // Note: queryOptions should be a tRPC queryOptions function
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryOptions: (
    params: {
      sort: { orderBy: string; direction: "asc" | "desc" };
      pagination: { pageIndex: number; pageSize: number };
      filters: TFilters;
    },
    opts?: any,
  ) => any;
  buildFilters: (tableState: ReturnType<typeof useTableState>) => TFilters;
  tableStateOptions?: TableStateOptions;
}

export interface UseTableListReturn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
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
export function useTableList<TFilters>({
  queryOptions,
  buildFilters,
  tableStateOptions,
}: UseTableListOptions<TFilters>): UseTableListReturn {
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
  );

  // Type assertion: tRPC list query response structure
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typedResponse = response as
    | { items: any[]; count: number; meta?: { totalCount?: number } }
    | undefined;

  return {
    data: typedResponse?.items || [],
    totalCount: typedResponse?.meta?.totalCount || typedResponse?.count || 0,
    isLoading,
    error: error as Error | null,
    tableState,
  };
}
