import { useEffect, useMemo, useRef } from "react";
import type { QueryTiming } from "~/lib/query-timing";
import type { TableStateReturn } from "../data-table/useTableState";

export interface ListQueryResponse<TData> {
  items: TData[];
  meta: { pageIndex: number; pageSize: number; totalCount: number };
}

// tRPC queryOptions carries internal generics that don't map cleanly to a simple
// function type. The filter generic still keeps callers honest at the boundary.
export type TRPCQueryOptionsFn<TFilters> = (params: {
  sort: { orderBy: string; direction: "asc" | "desc" };
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

  const sortParams = useMemo(() => tableState.getSortParams(), [tableState]);
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

export function useQueryTiming(isFetching: boolean): QueryTiming {
  const startTimeRef = useRef<number | null>(null);
  const timingRef = useRef<QueryTiming>({
    durationMs: null,
    isFresh: false,
  });

  useEffect(() => {
    if (isFetching && startTimeRef.current === null) {
      startTimeRef.current = performance.now();
    }
  }, [isFetching]);

  useEffect(() => {
    if (!isFetching && startTimeRef.current !== null) {
      const duration = Math.round(performance.now() - startTimeRef.current);
      timingRef.current = { durationMs: duration, isFresh: true };
      startTimeRef.current = null;
    }
  }, [isFetching]);

  return timingRef.current;
}
