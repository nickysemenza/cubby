import type { paginatedMetaSchema } from "@cubby/schemas/pagination";
import type {
  ListGroupBy,
  ListNesting,
  ListResultMembership,
} from "@cubby/schemas/pagination";
import type { QueryKey, QueryMeta } from "@tanstack/react-query";
import { useMemo } from "react";
import type { z } from "zod";

import type { TableStateReturn } from "../../entity/table/use-table-state";

export interface ListQueryResponse<TData> {
  items: TData[];
  meta: z.output<typeof paginatedMetaSchema>;
}

/**
 * A fully-bound finite list request.
 *
 * Query descriptors retain their own cache-key type; this module adapts that
 * descriptor exactly once into the smaller interface the infinite pager needs.
 * The row type therefore travels with both the key and the executor instead of
 * being represented by a phantom result field beside an untyped callback.
 */
export interface ListQueryPlan<
  TData,
  TPage extends ListQueryResponse<TData> = ListQueryResponse<TData>,
> {
  queryKey: QueryKey;
  meta?: QueryMeta;
  execute: (signal: AbortSignal, consistency?: "strong") => Promise<TPage>;
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
  TPage extends ListQueryResponse<TData> = ListQueryResponse<TData>,
> = (params: {
  /** Sort stack, primary first. */
  sort?: Array<{ orderBy: string; direction: "asc" | "desc" }>;
  pagination: { pageIndex: number; pageSize: number };
  filters: TFilters;
  groupBy?: ListGroupBy[];
  /** A declared tree's scope; omitted reads the flat list. */
  nesting?: ListNesting;
  resultMembership?: ListResultMembership;
  includeCount?: boolean;
}) => ListQueryPlan<TData, TPage>;

interface UsePaginatedTableCoreOptions<
  TFilters,
  TData extends { id: string },
  TPage extends ListQueryResponse<TData>,
> {
  queryOptions: ListQueryOptionsFn<TFilters, TData, TPage>;
  buildFilters: (tableState: TableStateReturn) => TFilters;
  tableState: TableStateReturn;
  groupBy?: ListGroupBy[];
  includeCount?: boolean;
}

export function usePaginatedTableCore<
  TFilters,
  TData extends { id: string },
  TPage extends ListQueryResponse<TData> = ListQueryResponse<TData>,
>({
  queryOptions,
  buildFilters,
  tableState,
  groupBy,
  includeCount,
}: UsePaginatedTableCoreOptions<TFilters, TData, TPage>) {
  const filters = useMemo(
    () => buildFilters(tableState),
    [buildFilters, tableState],
  );

  const sortParams = useMemo(() => tableState.getSorts(), [tableState]);
  const searching = tableState.hasPrimarySearch;
  const { pagination } = tableState;

  const queryParams = useMemo((): Parameters<
    ListQueryOptionsFn<TFilters, TData, TPage>
  >[0] => {
    const params: Parameters<ListQueryOptionsFn<TFilters, TData, TPage>>[0] = {
      pagination,
      filters,
    };
    if (includeCount !== undefined) params.includeCount = includeCount;
    if (!searching || tableState.hasExplicitSort) params.sort = sortParams;
    if (groupBy) params.groupBy = groupBy;
    return params;
  }, [
    sortParams,
    pagination,
    filters,
    groupBy,
    includeCount,
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
