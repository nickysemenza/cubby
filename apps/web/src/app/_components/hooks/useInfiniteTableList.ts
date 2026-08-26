import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import {
  infiniteOperationQueryKey,
  type OperationQueryKey,
} from "~/integrations/tanstack-query/operation-catalog";
import type { QueryTiming } from "~/lib/query-timing";
import type { TableStateReturn } from "../data-table/useTableState";
import {
  flattenUniquePageItems,
  type IdentifiedListRow,
} from "./infinite-page-utils";
import {
  type ListQueryOptionsFn,
  type ListQueryResponse,
  usePaginatedTableCore,
} from "./usePaginatedTableCore";

interface UseInfiniteTableListOptions<TFilters> {
  queryOptions: ListQueryOptionsFn<TFilters>;
  buildFilters: (tableState: TableStateReturn) => TFilters;
  /** Shared table state, owned by the caller (one instance per page). */
  tableState: TableStateReturn;
  /** DB column name to group by (prepends primary ORDER BY on server) */
  groupBy?: string;
}

export interface InfiniteScrollControls<
  TData extends IdentifiedListRow = IdentifiedListRow,
> {
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** Previous query rows are visible while a new filter/sort first page loads. */
  isTransitioning: boolean;
  /**
   * Fetch every remaining page (up to `cap` accumulated rows) so all matching
   * rows are in memory, resolving with the full flattened set. Used by "select
   * all N matching": callers select from the RETURNED items, not the table's
   * row model, which hasn't re-rendered with the new pages yet.
   */
  loadAllPages: (cap?: number) => Promise<TData[]>;
}

interface UseInfiniteTableListReturn<TData extends IdentifiedListRow> {
  data: TData[];
  totalCount: number;
  /** Server-computed full-filtered-set column sums (footer totals). */
  sums?: Record<string, number>;
  isLoading: boolean;
  error: Error | null;
  tableState: TableStateReturn;
  timing: QueryTiming;
  infiniteScroll: InfiniteScrollControls<TData>;
  refreshControls: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
}

/**
 * Hook for managing infinite-scrolling table list queries.
 *
 * Uses useInfiniteQuery to accumulate pages client-side.
 * This is the sole server-backed entity-list data path.
 */
export function useInfiniteTableList<
  TFilters,
  TData extends IdentifiedListRow,
>({
  queryOptions,
  buildFilters,
  tableState,
  groupBy,
}: UseInfiniteTableListOptions<TFilters>): UseInfiniteTableListReturn<TData> {
  const { filters, sortParams, pagination } = usePaginatedTableCore({
    queryOptions,
    buildFilters,
    tableState,
    groupBy,
  });

  const infiniteQueryKey = useMemo(() => {
    const finiteQueryKey = queryOptions({
      sort: sortParams,
      pagination: { pageIndex: 0, pageSize: pagination.pageSize },
      filters,
      ...(groupBy && { groupBy }),
    }).queryKey;
    return finiteQueryKey[0] === "operation"
      ? infiniteOperationQueryKey(finiteQueryKey as OperationQueryKey<unknown>)
      : [...finiteQueryKey, "__infinite__"];
  }, [queryOptions, sortParams, pagination.pageSize, filters, groupBy]);

  const pageOptions = useMemo(
    () => (pageParam: number) =>
      queryOptions({
        sort: sortParams,
        pagination: { pageIndex: pageParam, pageSize: pagination.pageSize },
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
    isPlaceholderData,
    isRefetching,
    refetch,
  } = useInfiniteQuery({
    // Filter/sort changes swap the queryKey; without this the accumulated
    // pages vanish for the refetch window, blanking rows AND the header
    // count (useEntityList withholds totalCount while isLoading).
    placeholderData: keepPreviousData,
    queryKey: infiniteQueryKey,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: number;
      signal: AbortSignal;
    }) => {
      const options = pageOptions(pageParam);
      return (await options.queryFn({
        queryKey: options.queryKey,
        signal,
      })) as ListQueryResponse<TData>;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage: ListQueryResponse<TData>) => {
      const meta = lastPage.meta;
      if (!meta.totalCount || !meta.pageSize) return undefined;
      const pageIndex = meta.pageIndex;
      const loaded = (pageIndex + 1) * meta.pageSize;
      return loaded < meta.totalCount ? pageIndex + 1 : undefined;
    },
  }) as {
    data:
      | { pages: ListQueryResponse<TData>[]; pageParams: number[] }
      | undefined;
    isLoading: boolean;
    error: Error | null;
    // useInfiniteQuery's fetchNextPage resolves with the updated observer
    // result (has .hasNextPage / .data) — awaited by loadAllPages below.
    fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<{
      hasNextPage?: boolean;
      data?: { pages: ListQueryResponse<TData>[] };
    }>;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isPlaceholderData: boolean;
    isRefetching: boolean;
    refetch: () => Promise<unknown>;
  };

  // Flatten all pages into a single array, with a row-identity backstop for an
  // overlapping or refetched page.
  const data = useMemo(
    () => flattenUniquePageItems(infiniteData?.pages),
    [infiniteData],
  );

  // Every page carries the same full-set aggregates; the latest page's are
  // the freshest after mutations invalidate/refetch.
  const totalCount = infiniteData?.pages[0]?.meta?.totalCount ?? 0;
  const sums = infiniteData?.pages.at(-1)?.meta?.sums;

  type FetchResult = Awaited<ReturnType<typeof fetchNextPage>>;
  const nextPageInFlightRef = useRef<Promise<FetchResult> | null>(null);
  const queryScope = JSON.stringify(infiniteQueryKey);
  const activeQueryScopeRef = useRef(queryScope);
  if (activeQueryScopeRef.current !== queryScope) {
    activeQueryScopeRef.current = queryScope;
    nextPageInFlightRef.current = null;
  }
  const latestStateRef = useRef({
    hasNextPage: hasNextPage ?? false,
    isTransitioning: isPlaceholderData,
    pages: infiniteData?.pages,
  });
  latestStateRef.current = {
    hasNextPage: hasNextPage ?? false,
    isTransitioning: isPlaceholderData,
    pages: infiniteData?.pages,
  };

  // IntersectionObserver can deliver more than once before React publishes
  // isFetchingNextPage. Serialize at the callback boundary as well as asking
  // TanStack Query not to cancel/restart an in-flight next-page request.
  const requestNextPage = useCallback((): Promise<FetchResult | null> => {
    if (
      latestStateRef.current.isTransitioning ||
      !latestStateRef.current.hasNextPage
    ) {
      return Promise.resolve(null);
    }
    if (nextPageInFlightRef.current) return nextPageInFlightRef.current;

    const request = fetchNextPage({ cancelRefetch: false }).finally(() => {
      if (nextPageInFlightRef.current === request) {
        nextPageInFlightRef.current = null;
      }
    });
    nextPageInFlightRef.current = request;
    return request;
  }, [fetchNextPage]);

  const guardedFetchNextPage = useCallback(() => {
    void requestNextPage();
  }, [requestNextPage]);

  // Pull every remaining page into memory (bounded), awaiting each fetch's
  // resolved result so we know when the set is complete.
  const loadAllPages = useCallback(
    async (cap = 3000): Promise<TData[]> => {
      let items = flattenUniquePageItems(latestStateRef.current.pages);
      if (latestStateRef.current.isTransitioning) return items;

      // Guard against an unbounded loop if the server keeps claiming more.
      let guard = 0;
      while (
        latestStateRef.current.hasNextPage &&
        items.length < cap &&
        guard < 100
      ) {
        guard += 1;
        const result = await requestNextPage();
        if (!result) break;
        items = flattenUniquePageItems(result.data?.pages);
        latestStateRef.current = {
          ...latestStateRef.current,
          hasNextPage: result.hasNextPage ?? false,
          pages: result.data?.pages,
        };
      }
      return items;
    },
    [requestNextPage],
  );

  const infiniteScroll = useMemo<InfiniteScrollControls<TData>>(
    () => ({
      fetchNextPage: guardedFetchNextPage,
      // Placeholder rows belong to the previous query. Never use their page
      // metadata to fetch into the new query while its first page is pending.
      hasNextPage: !isPlaceholderData && (hasNextPage ?? false),
      isFetchingNextPage,
      isTransitioning: isPlaceholderData,
      loadAllPages,
    }),
    [
      guardedFetchNextPage,
      hasNextPage,
      isFetchingNextPage,
      isPlaceholderData,
      loadAllPages,
    ],
  );

  return {
    data,
    totalCount,
    sums,
    isLoading,
    error: error instanceof Error ? error : null,
    tableState,
    // Infinite scroll doesn't track per-query timing
    timing: { durationMs: null, isFresh: false },
    infiniteScroll,
    refreshControls: {
      onRefresh: async () => {
        await refetch();
      },
      isRefreshing: isRefetching && !isFetchingNextPage,
    },
  };
}
