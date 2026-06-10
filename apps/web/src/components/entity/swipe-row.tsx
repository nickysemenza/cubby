import type { LucideIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "~/lib/utils";

export interface SwipeAction {
  label: string;
  icon: LucideIcon;
  tone?: "default" | "destructive";
  onAction: () => void;
}

/** Width of one revealed action button, px. */
const ACTION_WIDTH = 72;
/** Finger travel before we commit to an axis (px). */
const AXIS_LOCK = 8;

// Only one row's actions may be open at a time across the whole list.
let closeOpenRow: (() => void) | null = null;

/**
 * iOS-style swipe-to-reveal actions for mobile list rows. Swiping left slides
 * the row content over a strip of action buttons; tapping the row (or starting
 * a swipe on another row) closes it again. Vertical scrolling stays native via
 * `touch-action: pan-y` — we only take over once the gesture locks horizontal.
 * No full-swipe commit: actions always require an explicit tap.
 */
export function SwipeRow({
  actions,
  children,
  className,
}: {
  actions: SwipeAction[];
  children: ReactNode;
  className?: string;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Latest offset, readable synchronously — a fast swipe can deliver its
  // touchmove and touchend in the same frame, before React re-renders, so
  // the touchend handler must not trust the `offset` it closed over.
  const offsetRef = useRef(0);
  const moveTo = (value: number) => {
    offsetRef.current = value;
    setOffset(value);
  };
  const gesture = useRef<{
    x: number;
    y: number;
    base: number;
    axis: "none" | "h" | "v";
  }>({ x: 0, y: 0, base: 0, axis: "none" });
  const didDrag = useRef(false);
  // Stable closer so the single-open registry can compare identities.
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => moveTo(0);
  const close = useRef(() => closeRef.current()).current;

  const width = actions.length * ACTION_WIDTH;
  const isOpen = offset !== 0;

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    gesture.current = {
      x: t.clientX,
      y: t.clientY,
      base: offsetRef.current,
      axis: "none",
    };
    didDrag.current = false;
    setDragging(true);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - gesture.current.x;
    const dy = t.clientY - gesture.current.y;
    if (gesture.current.axis === "none") {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      gesture.current.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (
        gesture.current.axis === "h" &&
        closeOpenRow &&
        closeOpenRow !== close
      ) {
        closeOpenRow();
        closeOpenRow = null;
      }
    }
    if (gesture.current.axis !== "h") return;
    didDrag.current = true;
    moveTo(Math.min(0, Math.max(-width, gesture.current.base + dx)));
  };

  const onTouchEnd = () => {
    setDragging(false);
    if (gesture.current.axis !== "h") return;
    const open = offsetRef.current < -width / 2;
    moveTo(open ? -width : 0);
    closeOpenRow = open ? close : null;
  };

  // A tap on the row while open (or right after a drag) closes instead of
  // navigating — capture phase so MobileCard's onClick never fires.
  const onClickCapture = (e: React.MouseEvent) => {
    if (didDrag.current || isOpen) {
      e.preventDefault();
      e.stopPropagation();
      didDrag.current = false;
      close();
      if (closeOpenRow === close) closeOpenRow = null;
    }
  };

  return (
    <div className={cn("relative overflow-hidden", className)}>
      <div
        className={cn(
          "absolute inset-y-0 right-0 flex",
          // Inert while hidden behind the row content — nothing (including
          // synthetic clicks) should reach a closed row's actions.
          !isOpen && "pointer-events-none",
        )}
        aria-hidden={!isOpen}
      >
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            tabIndex={isOpen ? 0 : -1}
            onClick={() => {
              close();
              closeOpenRow = null;
              action.onAction();
            }}
            className={cn(
              "flex w-[72px] flex-col items-center justify-center gap-1 font-medium font-mono text-2xs uppercase tracking-wider",
              action.tone === "destructive"
                ? "bg-destructive text-destructive-foreground"
                : "bg-muted text-foreground",
            )}
          >
            <action.icon className="h-4 w-4" />
            {action.label}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "relative touch-pan-y bg-background",
          !dragging && "transition-transform duration-200 ease-cozy",
        )}
        style={{ transform: `translateX(${offset}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
