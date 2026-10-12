import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export type ChipClusterItem = { key: string; label: string; node: ReactNode };

/** Two 12px chip lines and their 2px gap fit inside a 32px table row. */
const MAX_LINES = 2;

/**
 * Chips that wrap to at most two lines inside a fixed-height table row, then
 * count the rest as "+N" whose title names them. A single-line cluster used
 * to cut every chip to "Groce…", "Kitc…", "P…".
 *
 * `data-cell-wrap` keeps column fitting from sizing the column to every chip
 * on one line; the column fits the first chip and the rest wrap.
 */
export function ChipCluster({
  items,
  more = 0,
  limit = null,
  leading,
  trailing,
  className,
}: {
  items: readonly ChipClusterItem[];
  /** Items past a bounded preview's `items`; they count toward "+N". */
  more?: number;
  /** A declared most-chips bound; the rest count toward "+N" as well. */
  limit?: number | null;
  /** Muted state word before the chips ("Partial"). */
  leading?: ReactNode;
  /** After the chips, on the same lines ("View all"). */
  trailing?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  // A new item list or width starts over from every chip.
  const layoutKey = `${width}\u0000${items.map((item) => item.key).join("\u0000")}`;
  const all = Math.min(items.length, limit ?? items.length);
  const [fit, setFit] = useState({ key: layoutKey, shown: all });
  const shown = Math.min(fit.key === layoutKey ? fit.shown : all, all);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const parts = [...element.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    // Mixed text and chip heights centre a few pixels apart on one line.
    const tops = parts.map((part) => part.offsetTop).sort((a, b) => a - b);
    const lines = tops.filter(
      (top, index) => index === 0 || top - (tops[index - 1] ?? top) > 4,
    ).length;
    if (lines <= MAX_LINES || shown === 0) return;
    // Something sits on a third line: drop one chip and measure again until
    // the chips and their "+N" fit two lines.
    setFit({ key: layoutKey, shown: shown - 1 });
  }, [shown, layoutKey]);

  const hidden = items.slice(shown);
  return (
    <span
      ref={ref}
      data-cell-wrap=""
      title={items.map((item) => item.label).join(", ")}
      className={cn(
        "flex max-h-7 min-w-0 flex-wrap content-center items-center gap-x-1 gap-y-0.5 overflow-hidden leading-3 whitespace-normal",
        className,
      )}
    >
      {leading && (
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
          {leading}
        </span>
      )}
      {items.slice(0, shown).map((item) => (
        <span key={item.key} data-chip="" className="flex max-w-full min-w-0">
          {item.node}
        </span>
      ))}
      {hidden.length + more > 0 && (
        <span
          data-chip-overflow=""
          className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums"
          title={hidden.map((item) => item.label).join(", ") || undefined}
        >
          +{hidden.length + more}
        </span>
      )}
      {trailing && (
        <span className="shrink-0 text-[0.6875rem]">{trailing}</span>
      )}
    </span>
  );
}
