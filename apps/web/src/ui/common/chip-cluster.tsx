import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

export type ChipClusterItem = { key: string; label: string; node: ReactNode };

/** Two 12px chip lines and their 2px gap fit inside a 32px table row. */
const MAX_LINES = 2;
/** The cluster's height budget (`max-h-7`) and its line gap (`gap-y-0.5`). */
const BUDGET_PX = 28;
const LINE_GAP_PX = 2;

/**
 * Lines that fit the row for chips this tall. Regression: 20px pills wrapped
 * to a second line that the 32px cell clipped through the middle, because
 * only 12px chips fit two lines.
 */
export const chipLinesThatFit = (chipHeight: number, lines: number) =>
  Math.max(
    1,
    Math.min(
      lines,
      Math.floor((BUDGET_PX + LINE_GAP_PX) / (chipHeight + LINE_GAP_PX)),
    ),
  );

/**
 * Chips that wrap to at most two lines inside a fixed-height table row, then
 * count the rest as "+N" whose title names them. A single-line cluster used
 * to cut every chip to "Groce…", "Kitc…", "P…".
 *
 * `lines={1}` keeps one line: the first chip, then "+N" whose tooltip names
 * the rest (Impact labels, badge lists).
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
  renderOverflow,
  lines = MAX_LINES,
  className,
}: {
  items: readonly ChipClusterItem[];
  /** Replaces the plain "+N" text, e.g. with a disclosure listing the hidden
   * items; its node must stay as narrow as "+N" for the fit to hold. */
  renderOverflow?: (
    hidden: readonly ChipClusterItem[],
    count: number,
  ) => ReactNode;
  /** Items past a bounded preview's `items`; they count toward "+N". */
  more?: number;
  /** A declared most-chips bound; the rest count toward "+N" as well. */
  limit?: number | null;
  /** Most chip lines; chips taller than half the row get one regardless. */
  lines?: 1 | 2;
  /** Muted state word before the chips ("Partial"). */
  leading?: ReactNode;
  /** After the chips, on the same lines ("View all"). */
  trailing?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  // Anything that changes a chip's or the "+N" badge's width starts over from
  // every chip: a renamed label under the same key, or a new `more` count.
  const layoutKey = [
    width,
    more,
    ...items.flatMap((item) => [item.key, item.label]),
  ].join("\u0000");
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
    const used = tops.filter(
      (top, index) => index === 0 || top - (tops[index - 1] ?? top) > 4,
    ).length;
    const chipHeight = Math.max(
      0,
      ...parts
        .filter((part) => part.hasAttribute("data-chip"))
        .map((part) => part.offsetHeight),
    );
    const allowed = chipLinesThatFit(chipHeight, lines);
    const overflows =
      element.scrollHeight > element.clientHeight + 1 ||
      (allowed === 1 && element.scrollWidth > element.clientWidth + 1);
    if ((used <= allowed && !overflows) || shown <= 1) return;
    // Something sits on a third line, or two tall lines overflow the row:
    // drop one chip and measure again. Keep the last named value; its
    // bounded wrapper truncates instead of replacing the value with "+1".
    setFit({ key: layoutKey, shown: shown - 1 });
  }, [shown, layoutKey, lines]);

  const hidden = items.slice(shown);
  const count = hidden.length + more;
  return (
    <span
      ref={ref}
      data-cell-wrap=""
      // The "+N" tooltip names what is hidden; the native title only covers
      // a lone truncated chip, so the two never stack on one hover.
      title={
        count === 0 ? items.map((item) => item.label).join(", ") : undefined
      }
      className={cn(
        "flex max-h-7 min-w-0 flex-wrap content-center items-center gap-x-1 gap-y-0.5 overflow-hidden leading-3 whitespace-normal",
        (shown === 1 || lines === 1) && "flex-nowrap",
        className,
      )}
    >
      {leading && (
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
          {leading}
        </span>
      )}
      {items.slice(0, shown).map((item) => (
        <span
          key={item.key}
          data-chip=""
          title={count > 0 ? item.label : undefined}
          className={cn(
            "flex max-w-full min-w-0",
            shown === 1 && "max-h-7 overflow-hidden",
          )}
        >
          {item.node}
        </span>
      ))}
      {count > 0 &&
        (renderOverflow ? (
          <span data-chip-overflow="" className="flex shrink-0">
            {renderOverflow(hidden, count)}
          </span>
        ) : (
          <OverflowCount hidden={hidden} count={count} />
        ))}
      {trailing && (
        <span className="shrink-0 text-[0.6875rem]">{trailing}</span>
      )}
    </span>
  );
}

/**
 * "+N" for the chips that did not fit, with a tooltip naming them. A bounded
 * preview's uncounted remainder (`more`) is stated, not invented.
 */
function OverflowCount({
  hidden,
  count,
}: {
  hidden: readonly ChipClusterItem[];
  count: number;
}) {
  const unnamed = count - hidden.length;
  const names = hidden.map((item) => item.label);
  const content = [...names, ...(unnamed > 0 ? [`${unnamed} more`] : [])].join(
    ", ",
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-chip-overflow=""
            aria-label={`${count} more: ${content}`}
            className="shrink-0 cursor-default rounded-sm text-[0.6875rem] leading-3 text-muted-foreground tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        +{count}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
