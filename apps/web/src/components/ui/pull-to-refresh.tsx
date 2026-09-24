import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { useCallback, useRef, useState } from "react";
import { cn } from "~/lib/utils";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  /** Custom scroll position getter — defaults to container.scrollTop. Use () => window.scrollY for window-scrolled content. */
  getScrollTop?: () => number;
}

const PULL_THRESHOLD = 80; // pixels to trigger refresh
const MAX_PULL = 120; // max pull distance

/**
 * Wrapper that adds pull-to-refresh functionality to scrollable content.
 * Pull down from the top to trigger refresh.
 */
export function PullToRefresh({
  onRefresh,
  children,
  className,
  disabled = false,
  getScrollTop,
}: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const isPullingRef = useRef(false);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || isRefreshing) return;

      const container = containerRef.current;
      if (!container) return;

      // Only start pull if scrolled to top
      const scrollTop = getScrollTop ? getScrollTop() : container.scrollTop;
      if (scrollTop === 0 && e.touches[0]) {
        startYRef.current = e.touches[0].clientY;
        isPullingRef.current = true;
      }
    },
    [disabled, isRefreshing],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isPullingRef.current || disabled || isRefreshing) return;

      const touch = e.touches[0];
      if (!touch) return;
      const deltaY = touch.clientY - startYRef.current;

      if (deltaY > 0) {
        // Pulling down
        const distance = Math.min(MAX_PULL, deltaY * 0.5); // Apply resistance
        setPullDistance(distance);
      } else {
        // Pushing up - reset
        setPullDistance(0);
        isPullingRef.current = false;
      }
    },
    [disabled, isRefreshing],
  );

  const handleTouchEnd = useCallback(async () => {
    if (!isPullingRef.current) return;
    isPullingRef.current = false;

    if (pullDistance >= PULL_THRESHOLD && !isRefreshing) {
      setIsRefreshing(true);
      setPullDistance(60); // Hold at indicator position

      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, isRefreshing, onRefresh]);

  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-x-hidden overflow-y-auto", className)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull indicator */}
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-center overflow-hidden"
        style={{ height: pullDistance }}
      >
        <div
          className={cn(
            "flex items-center justify-center rounded-none bg-muted p-2 transition-transform",
            isRefreshing && "animate-pulse",
          )}
          style={{
            transform: `scale(${0.5 + progress * 0.5}) rotate(${progress * 180}deg)`,
            opacity: progress,
          }}
        >
          <CircleNotchIcon
            className={cn("size-5 text-muted-foreground", isRefreshing && "animate-spin")}
          />
        </div>
      </div>

      {/* Content with offset */}
      <div
        style={{
          transform: `translateY(${pullDistance}px)`,
          transition: isPullingRef.current ? "none" : "transform 200ms ease-out",
        }}
      >
        {children}
      </div>
    </div>
  );
}
