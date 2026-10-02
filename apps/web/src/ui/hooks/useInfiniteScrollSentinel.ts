import { useCallback, useEffect, useRef } from "react";

import type { InfiniteScrollControls } from "./useInfiniteTableList";

export function useInfiniteScrollSentinel(
  controls: InfiniteScrollControls | undefined,
  rootMargin: string,
) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchNextPage = controls?.fetchNextPage;
  const hasNextPage = controls?.hasNextPage ?? false;
  const isFetchingNextPage = controls?.isFetchingNextPage ?? false;
  const isTransitioning = controls?.isTransitioning ?? false;

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (
        entries[0]?.isIntersecting &&
        hasNextPage &&
        !isFetchingNextPage &&
        !isTransitioning
      ) {
        fetchNextPage?.();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage, isTransitioning],
  );

  useEffect(() => {
    if (!controls) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(handleIntersect, { rootMargin });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [controls, handleIntersect, rootMargin]);

  return sentinelRef;
}
