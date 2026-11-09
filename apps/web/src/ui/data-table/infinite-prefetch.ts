import { useEffect } from "react";

import type { InfiniteScrollControls } from "../../entity/hooks/use-infinite-table-list";

/**
 * Whether an infinite list should request its next page now. Driven by the
 * virtualizer's rendered range on every change, not by an IntersectionObserver
 * on a sentinel: the observer fired only ~600px before the end (a visible stall
 * at each page boundary) and only on intersection *changes*, so a
 * state flip while the sentinel was already in view never fetched.
 *
 * Runway is two panes of rows, with a 30-row floor.
 */
export function shouldPrefetchNextPage({
  lastRenderedIndex,
  rowCount,
  visibleRows,
  scrollOffset,
  hasNextPage,
  isFetchingNextPage,
  isTransitioning,
}: {
  lastRenderedIndex: number;
  rowCount: number;
  visibleRows: number;
  scrollOffset: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isTransitioning: boolean;
}): boolean {
  if (!hasNextPage || isFetchingNextPage || isTransitioning || rowCount === 0)
    return false;
  // Fill an undersized pane, but leave a full opening viewport quiet. Starting
  // the runway on mount competes with primary paint and can drain several pages
  // before a person scrolls; a restored offset still counts as scroll demand.
  if (scrollOffset <= 0 && rowCount > visibleRows) return false;
  const runway = Math.max(30, visibleRows * 2);
  return lastRenderedIndex >= rowCount - runway;
}

/** Request the next page whenever the rendered range nears the end. */
export function useInfinitePrefetch({
  infiniteScroll,
  isMobile,
  lastRenderedIndex,
  rowCount,
  visibleRows,
  scrollOffset,
}: {
  infiniteScroll?: InfiniteScrollControls;
  isMobile: boolean;
  lastRenderedIndex: number;
  /** Size of the virtualizer's index space (rows plus group headers). */
  rowCount: number;
  visibleRows: number;
  scrollOffset: number;
}) {
  const prefetch =
    !isMobile &&
    infiniteScroll != null &&
    shouldPrefetchNextPage({
      lastRenderedIndex,
      rowCount,
      visibleRows,
      scrollOffset,
      hasNextPage: infiniteScroll.hasNextPage,
      isFetchingNextPage: infiniteScroll.isFetchingNextPage,
      isTransitioning: infiniteScroll.isTransitioning,
    });
  const fetchNextPage = infiniteScroll?.fetchNextPage;
  useEffect(() => {
    if (prefetch) void fetchNextPage?.();
  }, [prefetch, rowCount, fetchNextPage]);
}
