import { useMemo } from "react";
import type { TableStateReturn } from "../data-table/useTableState";

export interface ListQueryResponse<TData> {
  items: TData[];
  meta: {
    pageIndex: number;
    pageSize: number;
    totalCount: number;
    /** Full-filtered-set column aggregates (footer totals), by column id. */
    sums?: Record<string, number>;
  };
}

// tRPC queryOptions carries internal generics that don't map cleanly to a simple
// function type. The filter generic still keeps callers honest at the boundary.
export type TRPCQueryOptionsFn<TFilters> = (params: {
  /** Sort stack (multi-sort); the schema also accepts the legacy single object. */
  sort: Array<{ orderBy: string; direction: "asc" | "desc" }>;
  pagination: { pageIndex: number; pageSize: number };
  filters: TFilters;
  groupBy?: string;
  // biome-ignore lint/suspicious/noExplicitAny: intentional tRPC boundary
}) => any;

interface UsePaginatedTableCoreOptions<TFilters> {
  queryOptions: TRPCQueryOptionsFn<TFilters>;
  buildFilters: (tableState: TableStateReturn) => TFilters;
  tableState: TableStateReturn;
  groupBy?: string;
}

export function usePaginatedTableCore<TFilters>({
  queryOptions,
  buildFilters,
  tableState,
  groupBy,
}: UsePaginatedTableCoreOptions<TFilters>) {
  const filters = useMemo(
    () => buildFilters(tableState),
    [buildFilters, tableState],
  );

  const sortParams = useMemo(() => tableState.getSorts(), [tableState]);
  const { pagination } = tableState;

  const queryParams = useMemo(
    () => ({
      sort: sortParams,
      pagination,
      filters,
      ...(groupBy && { groupBy }),
    }),
    [sortParams, pagination, filters, groupBy],
  );

  const memoizedQueryOptions = useMemo(
    () => queryOptions(queryParams),
    [queryOptions, queryParams],
  );

  return {
    filters,
    sortParams,
    pagination,
    queryParams,
    memoizedQueryOptions,
  };
}
