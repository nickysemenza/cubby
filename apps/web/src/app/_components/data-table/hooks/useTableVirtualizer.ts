import {
  useWindowVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";

// Estimated height for section headers (smaller than data rows).
const SECTION_HEADER_HEIGHT = 28;

/**
 * Interleaved header/row item produced by `useDesktopGroupedRows`. Duplicated
 * structurally (not imported) so the index-math helpers below stay free of any
 * `~/` alias imports and can be unit-tested in the alias-free vitest project.
 */
export type GroupedItem =
  | { kind: "header"; title: string; count: number; color: string }
  | { kind: "row"; rowIndex: number; groupRowIndex: number };

/**
 * What `virtualRow.index` points at, given the grouped/flat index space.
 *
 *  - flat: the virtualizer counts data rows, so the index *is* the row index.
 *  - grouped: the virtualizer counts interleaved header+row items, so a virtual
 *    index resolves to either a section header or a flat row index.
 *
 * Pure (no React, no aliases) so the grouped-vs-flat mapping can be tested in
 * isolation.
 */
type ResolvedVirtualIndex =
  | { kind: "header"; title: string; count: number; color: string }
  /** groupRowIndex present only in grouped mode (position within the group). */
  | { kind: "row"; rowIndex: number; groupRowIndex?: number }
  | { kind: "sentinel" };

/**
 * Resolve a virtualizer index to its render target. When `groupedItems` is null
 * the index space is the flat rows array (index === rowIndex). When grouped, the
 * index space is the interleaved items array, which may land on a header.
 */
export function resolveVirtualIndex(
  index: number,
  groupedItems: GroupedItem[] | null,
  trailingSentinel = false,
  rowCount = 0,
): ResolvedVirtualIndex {
  const count = groupedItems ? groupedItems.length : rowCount;
  if (trailingSentinel && index === count) {
    return { kind: "sentinel" };
  }
  if (!groupedItems) {
    return { kind: "row", rowIndex: index };
  }
  // index is bounded by the virtualizer count (= groupedItems.length)
  const item = groupedItems[index]!;
  return item;
}

/**
 * Map a flat data-row index to its position in the virtualizer's index space.
 * Flat lists map 1:1; grouped lists must skip past interleaved section headers.
 * Returns -1 when the row isn't present (mirrors `Array.findIndex`).
 */
export function flatRowToVirtualIndex(
  rowIndex: number,
  groupedItems: GroupedItem[] | null,
): number {
  if (!groupedItems) return rowIndex;
  return groupedItems.findIndex(
    (it) => it.kind === "row" && it.rowIndex === rowIndex,
  );
}

/** Stable virtualizer key for a row, group header, or infinite sentinel. */
export function tableVirtualItemKey(
  index: number,
  rowKeys: string[],
  groupedItems: GroupedItem[] | null,
  trailingSentinel = false,
): string {
  const baseCount = groupedItems ? groupedItems.length : rowKeys.length;
  if (trailingSentinel && index === baseCount) return "sentinel:infinite";
  if (groupedItems) {
    const item = groupedItems[index];
    if (!item) return `missing:${index}`;
    if (item.kind === "header") return `group:${item.title}`;
    return `row:${rowKeys[item.rowIndex] ?? item.rowIndex}`;
  }
  return `row:${rowKeys[index] ?? index}`;
}

interface UseTableVirtualizerArgs {
  /** Number of data rows (flat list length). */
  rowCount: number;
  /** Stable TanStack row ids in flat row order. */
  rowKeys: string[];
  /** Interleaved header+row items when grouping is active, else null. */
  groupedItems: GroupedItem[] | null;
  /** Per-row height from the active density config. */
  rowHeight: number;
  /** Disable measurement/virtualization on mobile (renders a different view). */
  isMobile: boolean;
  /** Add one virtual trailing row for infinite-scroll loading/status. */
  trailingSentinel?: boolean;
}

interface UseTableVirtualizerResult {
  /** Anchor for the table body; supplies the virtualizer's scrollMargin. */
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Sticky-toolbar measurement target (its height shifts the body down). */
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  /** Measured sticky-toolbar height. */
  toolbarHeight: number;
  /** Document-top offset of the table body, used as scrollMargin. */
  scrollMargin: number;
  /** Currently virtualized rows. */
  virtualRows: VirtualItem[];
  /** Total scroll height the spacer rows must fill. */
  totalSize: number;
  /** Resolve a `virtualRow.index` to its render target (header or flat row). */
  resolveIndex: (index: number) => ResolvedVirtualIndex;
  /** Map a flat row index into the virtualizer index space (-1 if absent). */
  flatRowToVirtualIndex: (rowIndex: number) => number;
  /** Scroll a virtualizer index into view. */
  scrollToIndex: (index: number, options?: { align?: "auto" }) => void;
}

/**
 * Owns the window-virtualizer setup for the desktop data table: body/toolbar
 * refs, document-offset (scrollMargin) and toolbar-height measurement, the
 * virtualizer instance, and the grouped-vs-flat index math. Pure mechanical
 * extraction from `Table.tsx` — no behavior change.
 */
export function useTableVirtualizer({
  rowCount,
  rowKeys,
  groupedItems,
  rowHeight,
  isMobile,
  trailingSentinel = false,
}: UseTableVirtualizerArgs): UseTableVirtualizerResult {
  // Ref for virtualization scroll container
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // The list scrolls with the whole page (window virtualization), so the
  // virtualizer needs the table body's distance from the top of the document as
  // its scrollMargin. Re-measured on resize and whenever the toolbar height
  // changes (the toolbar sits above the body, so it shifts the body down).
  const [scrollMargin, setScrollMargin] = useState(0);

  // The sticky column header pins *below* the sticky toolbar, whose height is
  // dynamic (filter row, bulk-action bar). Measure it so the header's sticky
  // offset tracks it instead of using a hardcoded value.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || isMobile) return;
    setToolbarHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setToolbarHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);

  const measureScrollMargin = useCallback(() => {
    const el = tableContainerRef.current;
    if (!el || isMobile) return;
    // Round away sub-pixel noise from browser zoom. The table's document
    // offset is stable while scrolling, so a fractional wobble must not drive
    // a render on every scroll frame.
    const next = Math.round(el.getBoundingClientRect().top + window.scrollY);
    setScrollMargin((current) => (current === next ? current : next));
  }, [isMobile]);

  // A lower table can be pushed down after it has mounted when an async table
  // above it replaces a loading row with its real virtualized height. Watching
  // only this element (or window resize) misses that position-only layout
  // shift, so observe the document body and remeasure on the next frame. The
  // scroll listener is a fallback for offset changes that preserve the body's
  // total height (for example, one preceding section grows while another
  // shrinks).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowCount and toolbarHeight deliberately retrigger the document-offset measurement after this table's own async layout changes.
  useEffect(() => {
    const el = tableContainerRef.current;
    if (!el || isMobile) return;
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measureScrollMargin();
      });
    };

    measureScrollMargin();
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, { passive: true });
    const bodyObserver = new ResizeObserver(scheduleMeasure);
    bodyObserver.observe(document.body);

    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure);
      bodyObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isMobile, measureScrollMargin, rowCount, toolbarHeight]);

  // Always virtualize for consistent rendering
  const baseCount = groupedItems ? groupedItems.length : rowCount;
  const virtualizerCount = baseCount + (trailingSentinel ? 1 : 0);
  // Buffer ~one viewport of rows above/below so a fast fling doesn't outrun the
  // rendered range and flash blank. Rows are cheap to render (profiled), so the
  // extra DOM is affordable; clamped to keep tiny/huge viewports sane.
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const overscan = Math.min(40, Math.max(12, Math.ceil(viewportH / rowHeight)));
  const getItemKey = useCallback(
    (index: number) =>
      tableVirtualItemKey(index, rowKeys, groupedItems, trailingSentinel),
    [groupedItems, rowKeys, trailingSentinel],
  );
  const rowVirtualizer = useWindowVirtualizer({
    count: virtualizerCount,
    getItemKey,
    estimateSize: (index) => {
      if (trailingSentinel && index === baseCount) {
        return rowHeight;
      }
      if (groupedItems && groupedItems[index]!.kind === "header") {
        return SECTION_HEADER_HEIGHT;
      }
      return rowHeight;
    },
    overscan,
    scrollMargin,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return {
    tableContainerRef,
    toolbarRef,
    toolbarHeight,
    scrollMargin,
    virtualRows,
    totalSize,
    resolveIndex: (index) =>
      resolveVirtualIndex(index, groupedItems, trailingSentinel, rowCount),
    flatRowToVirtualIndex: (rowIndex) =>
      flatRowToVirtualIndex(rowIndex, groupedItems),
    scrollToIndex: (index, options) =>
      rowVirtualizer.scrollToIndex(index, options),
  };
}
