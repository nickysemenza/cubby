import { useInfiniteQuery } from "@tanstack/react-query";

type Page<T> = { items: T[]; meta: { totalCount: number } };

/**
 * Offset-paginated infinite list over a tRPC `*.list` procedure. The Cubby list
 * procedures page by `{ pageIndex, pageSize }` (not a cursor), so we drive a
 * plain useInfiniteQuery and feed pageIndex through `fetchPage`.
 */
export function useInfiniteList<T>(opts: {
  queryKey: unknown[];
  pageSize: number;
  fetchPage: (pageIndex: number, pageSize: number) => Promise<Page<T>>;
}) {
  const q = useInfiniteQuery({
    queryKey: opts.queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => opts.fetchPage(pageParam, opts.pageSize),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.meta.totalCount ? allPages.length : undefined;
    },
  });

  return {
    items: q.data?.pages.flatMap((p) => p.items) ?? [],
    totalCount: q.data?.pages[0]?.meta.totalCount,
    isLoading: q.isLoading,
    isRefetching: q.isRefetching,
    error: q.error,
    refetch: () => void q.refetch(),
    isFetchingMore: q.isFetchingNextPage,
    onEndReached: () => {
      if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    },
  };
}
