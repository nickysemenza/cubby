import type { VirtualItem } from "@tanstack/react-virtual";
import { useEffect } from "react";

import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";

/**
 * Whether an infinite list should request its next page now. Driven by the
 * virtualizer's rendered range on every change, not by an IntersectionObserver
 * on a sentinel: the observer fired only ~600px before the end (a visible stall
 * at every 100-row page boundary) and only on intersection *changes*, so a
 * state flip while the sentinel was already in view never fetched.
 *
 * Runway is two panes of rows, with a 30-row floor.
 */
export function shouldPrefetchNextPage({
  lastRenderedIndex,
  rowCount,
  visibleRows,
  hasNextPage,
  isFetchingNextPage,
  isTransitioning,
}: {
  lastRenderedIndex: number;
  rowCount: number;
  visibleRows: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isTransitioning: boolean;
}): boolean {
  if (!hasNextPage || isFetchingNextPage || isTransitioning || rowCount === 0)
    return false;
  const runway = Math.max(30, visibleRows * 2);
  return lastRenderedIndex >= rowCount - runway;
}

/** Request the next page whenever the rendered range nears the end. */
export function useInfinitePrefetch({
  infiniteScroll,
  isMobile,
  virtualRows,
  rowCount,
  visibleRows,
}: {
  infiniteScroll?: InfiniteScrollControls;
  isMobile: boolean;
  virtualRows: readonly VirtualItem[];
  /** Size of the virtualizer's index space (rows plus group headers). */
  rowCount: number;
  visibleRows: number;
}) {
  const prefetch =
    !isMobile &&
    infiniteScroll != null &&
    shouldPrefetchNextPage({
      lastRenderedIndex: virtualRows.at(-1)?.index ?? -1,
      rowCount,
      visibleRows,
      hasNextPage: infiniteScroll.hasNextPage,
      isFetchingNextPage: infiniteScroll.isFetchingNextPage,
      isTransitioning: infiniteScroll.isTransitioning,
    });
  const fetchNextPage = infiniteScroll?.fetchNextPage;
  useEffect(() => {
    if (prefetch) void fetchNextPage?.();
  }, [prefetch, rowCount, fetchNextPage]);
}
