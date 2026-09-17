import type { QueryKey, QueryMeta } from "@tanstack/react-query";
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

/**
 * A fully-bound finite list request.
 *
 * Query descriptors retain their own cache-key type; this module adapts that
 * descriptor exactly once into the smaller interface the infinite pager needs.
 * The row type therefore travels with both the key and the executor instead of
 * being represented by a phantom result field beside an untyped callback.
 */
export interface ListQueryPlan<TData> {
  queryKey: QueryKey;
  meta?: QueryMeta;
  execute: (signal: AbortSignal) => Promise<ListQueryResponse<TData>>;
}

/**
 * Finite list-query contract shared with the infinite-page adapter.
 *
 * The transport's cache key can remain as precise as its descriptor needs,
 * while the response keeps the row type correlated through every page.
 */
export type ListQueryOptionsFn<
  TFilters,
  TData extends { id: string } = { id: string },
> = (params: {
  /** Sort stack (multi-sort); the schema also accepts the legacy single object. */
  sort?: Array<{ orderBy: string; direction: "asc" | "desc" }>;
  pagination: { pageIndex: number; pageSize: number };
  filters: TFilters;
  groupBy?: string;
}) => ListQueryPlan<TData>;

interface UsePaginatedTableCoreOptions<TFilters, TData extends { id: string }> {
  queryOptions: ListQueryOptionsFn<TFilters, TData>;
  buildFilters: (tableState: TableStateReturn) => TFilters;
  tableState: TableStateReturn;
  groupBy?: string;
}

export function usePaginatedTableCore<TFilters, TData extends { id: string }>({
  queryOptions,
  buildFilters,
  tableState,
  groupBy,
}: UsePaginatedTableCoreOptions<TFilters, TData>) {
  const filters = useMemo(
    () => buildFilters(tableState),
    [buildFilters, tableState],
  );

  const sortParams = useMemo(() => tableState.getSorts(), [tableState]);
  const searching = tableState.hasPrimarySearch;
  const { pagination } = tableState;

  const queryParams = useMemo((): Parameters<
    ListQueryOptionsFn<TFilters, TData>
  >[0] => {
    const params: Parameters<ListQueryOptionsFn<TFilters, TData>>[0] = {
      pagination,
      filters,
    };
    if (!searching || tableState.hasExplicitSort) params.sort = sortParams;
    if (groupBy) params.groupBy = groupBy;
    return params;
  }, [
    sortParams,
    pagination,
    filters,
    groupBy,
    searching,
    tableState.hasExplicitSort,
  ]);

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
