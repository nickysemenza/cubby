import { useLocation } from "@tanstack/react-router";
import type { Table as ITable, Row } from "@tanstack/react-table";
import { useCallback, useEffect, useRef } from "react";
import { useDebug } from "~/hooks/useDebug";
import { useHydrated } from "~/hooks/useHydrated";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { useTableVirtualizer } from "./hooks/useTableVirtualizer";
import { useCellSelection } from "./useCellSelection";
import { useDesktopGroupedRows } from "./useDesktopGroupedRows";
import type { GroupConfig } from "./useGroupedList";
import { densityConfig, useTableDensity } from "./useTableDensity";

const scrollPositionCache = new Map<string, number>();

export function useDataTableController<TItem>({
  table,
  infiniteScroll,
  groupConfig,
  grouped,
  verticalAlign,
  onRowClick,
}: {
  table: ITable<TItem>;
  infiniteScroll?: InfiniteScrollControls;
  groupConfig?: GroupConfig<TItem>;
  grouped: boolean;
  verticalAlign: "top" | "middle";
  /** Row-open handler — used by cell selection's Cmd/Ctrl+Enter. */
  onRowClick?: (row: Row<TItem>) => void;
}) {
  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();
  // List queries are non-suspense and pending at SSR (loaders only
  // `void prefetchQuery`), so SSR always renders the loading row. If the query
  // resolves before hydration, the first client render would flip to the
  // empty/data state and mismatch SSR (CUBBY-3J / CUBBY-3). Keep showing the
  // loading row until hydrated so the first client render matches SSR.
  const hydrated = useHydrated();
  const pathname = useLocation({ select: (l) => l.pathname });
  const { density } = useTableDensity();
  const dConfig = densityConfig[density];

  const desktopInfiniteObserverRef = useRef<IntersectionObserver | null>(null);

  const fetchNextPage = infiniteScroll?.fetchNextPage;
  const hasNextPage = infiniteScroll?.hasNextPage ?? false;
  const isFetchingNextPage = infiniteScroll?.isFetchingNextPage ?? false;
  const hasDesktopInfiniteSentinel =
    !isMobile && !!infiniteScroll && (hasNextPage || isFetchingNextPage);

  const handleDesktopInfiniteIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage?.();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage],
  );

  const setDesktopInfiniteSentinel = useCallback(
    (sentinel: HTMLDivElement | null) => {
      desktopInfiniteObserverRef.current?.disconnect();
      desktopInfiniteObserverRef.current = null;
      if (isMobile || !infiniteScroll || !sentinel) return;

      const observer = new IntersectionObserver(
        handleDesktopInfiniteIntersect,
        {
          rootMargin: "600px",
        },
      );
      observer.observe(sentinel);
      desktopInfiniteObserverRef.current = observer;
    },
    [isMobile, infiniteScroll, handleDesktopInfiniteIntersect],
  );

  useEffect(() => {
    return () => desktopInfiniteObserverRef.current?.disconnect();
  }, []);

  const { rows } = table.getRowModel();

  // Desktop group detection (server trusts ordering)
  const groupedItems = useDesktopGroupedRows(rows, groupConfig, grouped);

  // Window virtualization: body/toolbar refs + measurement, the virtualizer
  // instance, and the grouped-vs-flat index math.
  const {
    tableContainerRef,
    toolbarRef,
    toolbarHeight,
    scrollMargin,
    virtualRows,
    totalSize,
    resolveIndex,
    flatRowToVirtualIndex,
    scrollToIndex,
  } = useTableVirtualizer({
    rowCount: rows.length,
    groupedItems,
    rowHeight: dConfig.rowHeight,
    isMobile,
    trailingSentinel: hasDesktopInfiniteSentinel,
  });

  // Spreadsheet-style cell selection (desktop only). Maps a flat row index into
  // the virtualizer's index space before scrolling — grouped tables interleave
  // section headers, so the flat index isn't the virtual index.
  const scrollToFlatRow = useCallback(
    (rowIndex: number) => {
      const virtualIndex = flatRowToVirtualIndex(rowIndex);
      if (virtualIndex >= 0) scrollToIndex(virtualIndex, { align: "auto" });
    },
    [flatRowToVirtualIndex, scrollToIndex],
  );

  const {
    selection,
    clearSelection,
    getRowCellSelection,
    containerProps: cellSelectionContainerProps,
  } = useCellSelection({
    enabled: !isMobile,
    rows,
    table,
    scrollToFlatRow,
    onOpenRow: onRowClick,
  });

  // Focused-row ring follows the selection's focus cell (flat row index). No
  // separate state — cell selection is the single source of truth.
  const focusedRowIndex = selection?.focus.row ?? null;

  // Save scroll position on unmount for navigate-back restoration. The page is
  // the scroller now, so we track window.scrollY rather than a container.
  const saveScrollPosition = useCallback(() => {
    if (typeof window !== "undefined" && window.scrollY > 0) {
      scrollPositionCache.set(pathname, window.scrollY);
    } else {
      scrollPositionCache.delete(pathname);
    }
  }, [pathname]);

  useEffect(() => {
    return () => saveScrollPosition();
  }, [saveScrollPosition]);

  // Restore scroll position when data loads (rows become available)
  const hasRestoredRef = useRef(false);
  // Reset the guard when the route changes so restore works again on the next
  // list (the RTable instance can be reused across list routes). Declared before
  // the restore effect so the flag is cleared before that effect re-evaluates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended trigger; the body only writes a ref so the linter sees it as unused
  useEffect(() => {
    hasRestoredRef.current = false;
  }, [pathname]);
  useEffect(() => {
    if (hasRestoredRef.current || isMobile) return;
    const savedPosition = scrollPositionCache.get(pathname);
    if (savedPosition && rows.length > 0) {
      // Use rAF to ensure the virtualizer has measured
      requestAnimationFrame(() => {
        window.scrollTo(0, savedPosition);
      });
      hasRestoredRef.current = true;
    }
  }, [pathname, rows.length, isMobile]);

  const styles = {
    table:
      "table-grid-lines border-separate border-spacing-0 text-sm leading-tight tabular-nums",
    header:
      "h-8 bg-card px-2 py-1 text-2xs font-mono font-semibold uppercase tracking-wider text-slate border-b-[3px] border-b-foreground",
    filterRow: "h-7 bg-card px-2 py-0.5 border-b border-border" /* tight */,
    cell: cn(
      dConfig.cellClass,
      "overflow-hidden",
      verticalAlign === "top" ? "align-top" : "align-middle",
    ),
    row: cn(dConfig.rowClass, "table-row-hover border-border border-b"),
    sortIcon: "h-3 w-3",
  };

  // Signature of currently-visible columns so memoized rows re-render when the
  // user toggles or reorders columns (row.original alone wouldn't change).
  const columnsKey = table
    .getVisibleLeafColumns()
    .map((c) => c.id)
    .join(",");

  // Columns the table actually renders. Use VISIBLE leaves: getAllColumns()
  // counts hidden columns too, so a colSpan built from it exceeds the rendered
  // column count and the browser invents a phantom trailing column that steals
  // table width — the "empty right half" bug under table-fixed. Shared by the
  // status rows and the virtualizer spacer rows below. +1 for the spacer.
  const colSpan =
    table.getVisibleLeafColumns().length + 1 + (isDebugEnabled ? 1 : 0);

  return {
    cellSelectionContainerProps,
    clearSelection,
    colSpan,
    columnsKey,
    dConfig,
    flatRowToVirtualIndex,
    focusedRowIndex,
    getRowCellSelection,
    hydrated,
    isDebugEnabled,
    isFetchingNextPage,
    isMobile,
    resolveIndex,
    rows,
    scrollMargin,
    scrollToIndex,
    setDesktopInfiniteSentinel,
    styles,
    tableContainerRef,
    toolbarHeight,
    toolbarRef,
    totalSize,
    virtualRows,
  };
}
