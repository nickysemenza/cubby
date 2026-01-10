import { Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";
import { cn } from "~/lib/utils";

interface SwipeableCardProps {
  children: React.ReactNode;
  onDelete?: () => void;
  className?: string;
  disabled?: boolean;
}

const SWIPE_THRESHOLD = 80; // pixels to trigger action
const MAX_SWIPE = 100; // max swipe distance

/**
 * Wrapper that adds swipe-to-delete functionality to any card content.
 * Swipe left to reveal delete action.
 */
export function SwipeableCard({
  children,
  onDelete,
  className,
  disabled = false,
}: SwipeableCardProps) {
  const [offset, setOffset] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const startXRef = useRef(0);

  const handleSwipeStart = useCallback(() => {
    setIsAnimating(false);
    startXRef.current = offset;
  }, [offset]);

  const handleSwiping = useCallback(
    (deltaX: number) => {
      if (disabled || !onDelete) return;

      // Only allow left swipe (negative delta)
      const newOffset = Math.max(
        -MAX_SWIPE,
        Math.min(0, startXRef.current - deltaX),
      );
      setOffset(newOffset);
    },
    [disabled, onDelete],
  );

  const handleSwipeEnd = useCallback(() => {
    setIsAnimating(true);

    if (Math.abs(offset) >= SWIPE_THRESHOLD) {
      // Triggered - keep showing action
      setOffset(-MAX_SWIPE);
    } else {
      // Not triggered - snap back
      setOffset(0);
    }
  }, [offset]);

  const handleDelete = useCallback(() => {
    if (onDelete) {
      setIsAnimating(true);
      // Animate out to the left
      setOffset(-300);
      // Call delete after animation
      setTimeout(() => {
        onDelete();
      }, 200);
    }
  }, [onDelete]);

  const handleReset = useCallback(() => {
    setIsAnimating(true);
    setOffset(0);
  }, []);

  const handlers = useSwipeable({
    onSwipeStart: handleSwipeStart,
    onSwiping: (e) => handleSwiping(e.deltaX),
    onSwiped: handleSwipeEnd,
    trackMouse: false,
    trackTouch: true,
    preventScrollOnSwipe: true,
    delta: 10,
  });

  // If no delete handler, just render children
  if (!onDelete) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={cn("relative overflow-hidden rounded-lg", className)}>
      {/* Delete action behind the card */}
      <div
        className={cn(
          "absolute inset-y-0 right-0 flex w-24 items-center justify-center bg-destructive text-destructive-foreground transition-opacity",
          offset < -10 ? "opacity-100" : "opacity-0",
        )}
      >
        <button
          type="button"
          onClick={handleDelete}
          className="flex h-full w-full items-center justify-center"
          aria-label="Delete"
        >
          <Trash2 className="h-6 w-6" />
        </button>
      </div>

      {/* Swipeable content */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: handlers include touch/mouse events for swipe gesture */}
      <div
        {...handlers}
        onClick={offset < -10 ? handleReset : undefined}
        style={{
          transform: `translateX(${offset}px)`,
          transition: isAnimating ? "transform 200ms ease-out" : "none",
        }}
        className="relative bg-background"
      >
        {children}
      </div>
    </div>
  );
}
