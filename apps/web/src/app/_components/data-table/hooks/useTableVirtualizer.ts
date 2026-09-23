import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";

// Estimated height for section headers (smaller than data rows).
const SECTION_HEADER_HEIGHT = 28;

/**
 * Interleaved header/row item produced by `useDesktopGroupedRows`. Duplicated
 * structurally (not imported) so the index-math helpers below stay free of any
 * `~/` alias imports and can be unit-tested in the alias-free vitest project.
 */
export type GroupedItem =
  | {
      kind: "header";
      key?: string;
      title: string;
      count: number;
      color: string;
    }
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
  | {
      kind: "header";
      key?: string;
      title: string;
      count: number;
      color: string;
    }
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
    if (item.kind === "header") return `group:${item.key ?? item.title}`;
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
  /**
   * Scroll offset to start the pane at, from the router's scroll-restoration
   * cache. Read by the caller (which owns the router coupling) so this hook
   * stays testable without a router; see useDataTableController.
   */
  initialOffset?: number;
}

interface UseTableVirtualizerResult {
  /** The scroll pane the virtualizer measures and the rows scroll inside. */
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
  /** The bordered wrapper the pane is bounded inside. */
  paneWrapperRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Pixel ceiling for the pane so it ends at the bottom of the viewport, or
   * null before the first measurement (and on mobile).
   */
  paneMaxHeight: number | null;
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
 * Owns the virtualizer setup for the desktop data table: pane/toolbar refs,
 * toolbar-height measurement, the virtualizer instance, and the grouped-vs-flat
 * index math.
 *
 * The rows scroll inside the table's own pane, not the window. That is what
 * lets the column header stay put on a HORIZONTAL scroll (a window-scrolled
 * table drags the whole page sideways, taking the nav rail and header with it)
 * — and it also removes the document-offset bookkeeping window virtualization
 * needs, since the pane's own scrollTop is already the right origin.
 */
export function useTableVirtualizer({
  rowCount,
  rowKeys,
  groupedItems,
  rowHeight,
  isMobile,
  trailingSentinel = false,
  initialOffset = 0,
}: UseTableVirtualizerArgs): UseTableVirtualizerResult {
  // Ref for virtualization scroll container
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // The pane is bounded to whatever is left of the viewport beneath it, so the
  // rows scroll inside the table instead of the page. Measured from the
  // wrapper's own top rather than a hardcoded chrome height, because the page
  // header above it differs per route. No scroll listener is needed: once the
  // pane fits the viewport the page itself stops scrolling, so this offset only
  // moves on resize.
  const paneWrapperRef = useRef<HTMLDivElement>(null);
  const [paneMaxHeight, setPaneMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    if (isMobile) return;
    const el = paneWrapperRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      // A floor keeps the table usable on a short viewport (or a tall page
      // header) instead of collapsing to a couple of rows.
      setPaneMaxHeight(Math.max(320, Math.round(window.innerHeight - top - 8)));
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [isMobile]);

  // Always virtualize for consistent rendering
  const baseCount = groupedItems ? groupedItems.length : rowCount;
  const virtualizerCount = baseCount + (trailingSentinel ? 1 : 0);
  // Buffer ~one viewport of rows above/below so a fast fling doesn't outrun the
  // rendered range and flash blank. Rows are cheap to render (profiled), so the
  // extra DOM is affordable; clamped to keep tiny/huge viewports sane.
  const viewportH = globalThis.window?.innerHeight ?? 800;
  const overscan = Math.min(40, Math.max(12, Math.ceil(viewportH / rowHeight)));
  const getItemKey = useCallback(
    (index: number) =>
      tableVirtualItemKey(index, rowKeys, groupedItems, trailingSentinel),
    [groupedItems, rowKeys, trailingSentinel],
  );
  const rowVirtualizer = useVirtualizer({
    getScrollElement: () => tableContainerRef.current,
    // The router restores a tracked element's scrollTop on `onRendered`, which
    // lands before the virtualizer has measured — on a virtualized pane that
    // clamps to 0 because totalSize is still tiny. Seeding the offset here
    // renders the right window of rows on the first pass instead.
    initialOffset: isMobile ? 0 : initialOffset,
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
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  return {
    tableContainerRef,
    paneWrapperRef,
    paneMaxHeight,
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
