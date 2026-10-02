import { useElementScrollRestoration } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useDebug } from "~/ui/hooks/useDebug";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { useIsMobile } from "~/ui/hooks/useMobile";

import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { columnWidthVariables } from "./column-layout";
import { ROW_DENSITY } from "./density";
import { useTableVirtualizer } from "./hooks/useTableVirtualizer";
import { useInfinitePrefetch } from "./infinite-prefetch";
import type { CubbyTable as ITable, CubbyRow as Row } from "./table-features";
import { useCellSelection } from "./useCellSelection";
import { useDesktopGroupedRows } from "./useDesktopGroupedRows";
import type { GroupConfig } from "./useGroupedList";

export function useDataTableController<TItem extends RowData>({
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
  const dConfig = ROW_DENSITY;

  const hasNextPage = infiniteScroll?.hasNextPage ?? false;
  const isFetchingNextPage = infiniteScroll?.isFetchingNextPage ?? false;
  const isTransitioning = infiniteScroll?.isTransitioning ?? false;
  const hasInfiniteScroll = infiniteScroll != null;
  const hasDesktopInfiniteSentinel =
    !isMobile &&
    hasInfiniteScroll &&
    !isTransitioning &&
    (hasNextPage || isFetchingNextPage);

  const { rows } = table.getRowModel();
  const rowKeys = useMemo(() => rows.map((row) => row.id), [rows]);

  // Desktop group detection (server trusts ordering)
  const groupedItems = useDesktopGroupedRows(rows, groupConfig, grouped);

  // Pane scroll restoration. The pane carries `data-scroll-restoration-id`
  // (see Table.tsx) so the router snapshots its offset against a stable
  // selector rather than a positional nth-child path that shifts as the chrome
  // above it renders. Read here rather than inside useTableVirtualizer so that
  // hook stays router-free and unit-testable.
  const scrollRestorationId = table.options.meta?.scrollRestorationId;
  const restorationEntry = useElementScrollRestoration({
    // An unkeyed (in-memory) table has no stable id; "" makes the lookup miss
    // and fall through to a 0 offset rather than restoring the wrong pane.
    id: scrollRestorationId ?? "",
  });

  // Pane virtualization: pane/toolbar refs + measurement, the virtualizer
  // instance, and the grouped-vs-flat index math.
  const {
    tableContainerRef,
    paneWrapperRef,
    paneMaxHeight,
    paneRows,
    virtualRowCount,
    virtualRows,
    totalSize,
    resolveIndex,
    flatRowToVirtualIndex,
    scrollToIndex,
  } = useTableVirtualizer({
    rowCount: rows.length,
    rowKeys,
    groupedItems,
    rowHeight: dConfig.rowHeight,
    isMobile,
    trailingSentinel: hasDesktopInfiniteSentinel,
    initialOffset: restorationEntry?.scrollY,
  });

  useInfinitePrefetch({
    infiniteScroll,
    isMobile,
    virtualRows,
    rowCount: virtualRowCount,
    visibleRows: paneRows,
  });

  // The table owns its horizontal scroll pane, so it is the only honest
  // source for surplus space. Keep the measurement transient: resizing a
  // window must not rewrite a person's saved column widths.
  const [tableContainerWidth, setTableContainerWidth] = useState(0);
  useEffect(() => {
    const ResizeObserverClass = globalThis.ResizeObserver;
    if (isMobile || !ResizeObserverClass) return;
    const pane = tableContainerRef.current;
    if (!pane) return;
    const measure = () => setTableContainerWidth(Math.round(pane.clientWidth));
    measure();
    const observer = new ResizeObserverClass(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [isMobile, tableContainerRef]);

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

  const { containerProps: cellSelectionContainerProps } = useCellSelection({
    enabled: !isMobile && !isTransitioning,
    rows,
    table,
    scrollToFlatRow,
    onOpenRow: onRowClick,
  });

  const styles = {
    table:
      "border-separate border-spacing-0 text-[0.8125rem] leading-5 tabular-nums",
    header:
      "h-8 overflow-hidden border-border border-b bg-card px-2 py-0 font-medium text-xs text-muted-foreground",
    cell: cn(
      dConfig.cellClass,
      // text-ellipsis gives every plain-text cell a real "…" instead of a
      // hard clip; decorated cells truncate inside CellFrame's value slot.
      "overflow-hidden text-ellipsis",
      verticalAlign === "top" ? "align-top" : "align-middle",
    ),
    row: cn(dConfig.rowClass, "table-row-hover border-b border-border"),
    sortIcon: "h-3 w-3",
  };

  // Signature of currently-visible columns so memoized rows re-render when the
  // user toggles or reorders columns (row.original alone wouldn't change).
  const columnsKey = table
    .getVisibleLeafColumns()
    .map((c) => c.id)
    .join(",");
  const columnSizesKey = table
    .getVisibleLeafColumns()
    .map((column) => `${column.id}:${column.getSize()}`)
    .join(",");
  // Columns a person resized (or a saved view sized) keep exactly that width;
  // pane slack only flows to the rest.
  const userSizedKey = Object.keys(table.state.columnSizing ?? {})
    .sort()
    .join(",");
  const columnSizeVars = useMemo(
    () =>
      columnWidthVariables(
        table.getVisibleLeafColumns(),
        tableContainerWidth,
        new Set(userSizedKey ? userSizedKey.split(",") : []),
      ),
    // oxlint-disable-next-line react/exhaustive-deps -- scalar signature stands in for TanStack's fresh column array
    [columnSizesKey, tableContainerWidth, userSizedKey],
  );

  // Columns the table actually renders. Use VISIBLE leaves: getAllColumns()
  // counts hidden columns too, so a colSpan built from it exceeds the rendered
  // column count and the browser invents a phantom trailing column that steals
  // table width — the "empty right half" bug under table-fixed. Shared by the
  // status rows and the virtualizer spacer rows below. +1 for the spacer.
  const colSpan =
    table.getVisibleLeafColumns().length + 1 + (isDebugEnabled ? 1 : 0);
  // Cell renderers may intentionally read ref-backed async state outside the
  // row object. Keep that dependency explicit for memoized render surfaces.
  const rowContentVersion = table.options.meta?.rowContentVersion;

  return {
    cellSelectionContainerProps,
    colSpan,
    columnsKey,
    columnSizeVars,
    dConfig,
    hydrated,
    isDebugEnabled,
    isFetchingNextPage,
    isTransitioning,
    isMobile,
    resolveIndex,
    rows,
    rowContentVersion,
    scrollRestorationId,
    styles,
    tableContainerRef,
    paneWrapperRef,
    paneMaxHeight,
    totalSize,
    virtualRows,
  };
}
