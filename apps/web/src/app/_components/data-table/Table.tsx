// cf https://ui.shadcn.com/docs/components/data-table

import type { Entity } from "@cubby/schemas/entity";
import { useLocation } from "@tanstack/react-router";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bug,
  LayoutList,
  List,
} from "lucide-react";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SwipeAction } from "~/components/entity/swipe-row";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { SpacedContainer } from "~/components/layout/spaced-container";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import { useDebug } from "~/hooks/useDebug";
import { useIsMobile } from "~/hooks/useMobile";
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DebugDialog } from "./DebugDialog";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableToolbar } from "./data-table-toolbar";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";
import { HeaderFilter } from "./HeaderFilter";
import { useTableVirtualizer } from "./hooks/useTableVirtualizer";
import { MobileListScreen } from "./MobileListScreen";
import { RowsPerPageSelect } from "./rows-per-page-select";
import { SectionHeader } from "./SectionHeader";
import { useDesktopGroupedRows } from "./useDesktopGroupedRows";
import type { GroupConfig } from "./useGroupedList";
import { densityConfig, useTableDensity } from "./useTableDensity";

// Scroll position cache for navigate-back restoration
const scrollPositionCache = new Map<string, number>();

// Sticky top nav height (h-16 = 4rem = 64px); the sticky toolbar pins below it.
const NAV_HEIGHT = 64;

// Faint row guides every `rowHeight` px so the virtualized spacer (the gap the
// renderer hasn't filled yet on a fast scroll) reads as empty table rows
// instead of stark white. Uses the table's border token at low alpha; no
// animation. Spacer heights are multiples of rowHeight, so lines align with
// where real rows sit.
function ghostRowsStyle(rowHeight: number): React.CSSProperties {
  const line = "color-mix(in oklch, var(--border) 45%, transparent)";
  return {
    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${rowHeight - 1}px, ${line} ${rowHeight - 1}px, ${line} ${rowHeight}px)`,
  };
}

interface TTableProps<TItem> {
  table: ITable<TItem>;
  /** Slot for additional toolbar content like summaries (e.g., "Value: $5,845.91") */
  additionalToolbarContent?: ReactNode;
  /** Primary actions for the toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
  isLoading?: boolean;
  error?: unknown;
  ariaLabel?: string;
  timing?: QueryTiming;
  /** Entity type for mobile card navigation - when provided, cards become clickable */
  entity?: Entity;
  /**
   * Custom render function for mobile cards.
   * Receives the row and the default card content, allowing full customization.
   * Useful for tables with inline editing or special mobile UX.
   */
  renderMobileCard?: (row: Row<TItem>, defaultContent: ReactNode) => ReactNode;
  /** Swipe-to-reveal actions per row on the mobile list */
  swipeActions?: (row: Row<TItem>) => SwipeAction[];
  /** Callback when a row is clicked */
  onRowClick?: (row: Row<TItem>) => void;
  /** Callback when a row is hovered (desktop) — used to prefetch row data */
  onRowHover?: (row: Row<TItem>) => void;
  /** Bulk action bar (rendered in toolbar when rows are selected) */
  bulkActionBar?: ReactNode;
  /** Infinite scroll controls — when provided, mobile hides pagination and auto-loads more */
  infiniteScroll?: InfiniteScrollControls;
  /** Pull-to-refresh controls for mobile list rendering */
  refreshControls?: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
  /** Group configuration for section headers (mobile + desktop) */
  groupConfig?: GroupConfig<TItem>;
  /** Whether grouping is currently active */
  grouped?: boolean;
  /** Toggle grouping on/off */
  onGroupedChange?: (value: boolean) => void;
  /**
   * Extra per-row classes (desktop). Must be a pure function of `row.original`
   * so memoized rows stay stable — e.g. tint estimated rows. Returns undefined
   * for the default styling.
   */
  getRowClassName?: (row: Row<TItem>) => string | undefined;
}

interface DataRowProps<TItem> {
  row: Row<TItem>;
  isSelected: boolean;
  isFocused: boolean;
  isDebugEnabled: boolean;
  onRowClick?: (row: Row<TItem>) => void;
  onRowHover?: (row: Row<TItem>) => void;
  rowClassName: string;
  cellClassName: string;
  /** Signature of visible column ids — re-render rows when columns toggle/reorder */
  columnsKey: string;
  height?: string;
}

function DataRowInner<TItem>({
  row,
  isSelected,
  isFocused,
  isDebugEnabled,
  onRowClick,
  onRowHover,
  rowClassName,
  cellClassName,
  height,
}: DataRowProps<TItem>) {
  return (
    <TableRow
      data-state={isSelected && "selected"}
      className={cn(
        rowClassName,
        onRowClick && "cursor-pointer",
        isFocused && "ring-2 ring-primary/30 ring-inset",
      )}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onMouseEnter={onRowHover ? () => onRowHover(row) : undefined}
      style={height ? { height } : undefined}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell
          key={cell.id}
          className={cn(cellClassName, cell.column.columnDef.meta?.className)}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
      {/* Add debug cell when debug mode is enabled */}
      {isDebugEnabled && (
        <TableCell className={cn(cellClassName)}>
          <DebugDialog
            data={row.original}
            title={`Debug Data - Row ${row.id}`}
            trigger={
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <Bug className="h-4 w-4" />
                <span className="sr-only">Debug row data</span>
              </Button>
            }
          />
        </TableCell>
      )}
    </TableRow>
  );
}

// Skip re-rendering rows that haven't actually changed. The virtualizer
// re-renders RTable on every scroll frame, so without this, flexRender runs for
// every visible cell each frame. We compare row.original (TanStack reuses the
// underlying data object across renders) plus the bits of table/UI state a row
// reads. NOTE: cells that read table-level state beyond selection/focus/column
// visibility won't re-render until row.original changes — none do today, so add
// to this comparator if you introduce one.
function rowPropsAreEqual<TItem>(
  prev: DataRowProps<TItem>,
  next: DataRowProps<TItem>,
): boolean {
  return (
    prev.row.original === next.row.original &&
    prev.isSelected === next.isSelected &&
    prev.isFocused === next.isFocused &&
    prev.isDebugEnabled === next.isDebugEnabled &&
    prev.onRowClick === next.onRowClick &&
    prev.onRowHover === next.onRowHover &&
    prev.rowClassName === next.rowClassName &&
    prev.cellClassName === next.cellClassName &&
    prev.columnsKey === next.columnsKey &&
    prev.height === next.height
  );
}

const DataRow = memo(DataRowInner, rowPropsAreEqual) as typeof DataRowInner;

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const {
    table,
    additionalToolbarContent,
    actions,
    bulkActionBar,
    isLoading = false,
    error,
    ariaLabel = "Data Table",
    timing,
    entity,
    renderMobileCard,
    swipeActions,
    onRowClick,
    onRowHover,
    infiniteScroll,
    refreshControls,
    groupConfig,
    grouped = false,
    onGroupedChange,
    getRowClassName,
  } = props;

  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();
  const pathname = useLocation({ select: (l) => l.pathname });
  const { density } = useTableDensity();
  const dConfig = densityConfig[density];

  // Keyboard navigation: focused row index (desktop only)
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null);

  // On desktop with infinite scroll, eagerly fetch all pages so client-side
  // pagination works over the complete dataset. Mobile uses scroll-to-load.
  // Depend on primitives (not the `infiniteScroll` object, which is recreated
  // every render) so this effect only re-runs when fetch state actually changes.
  const hasNextPage = infiniteScroll?.hasNextPage ?? false;
  const isFetchingNextPage = infiniteScroll?.isFetchingNextPage ?? false;
  const fetchNextPage = infiniteScroll?.fetchNextPage;
  useEffect(() => {
    if (!isMobile && hasNextPage && !isFetchingNextPage) {
      fetchNextPage?.();
    }
  }, [isMobile, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
  });

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
    table: "text-xs leading-tight border-collapse border-spacing-0",
    header:
      "h-8 px-2 py-1 text-2xs font-mono font-semibold uppercase tracking-wider text-eyebrow border-b border-[var(--border-chunky)]",
    filterRow: "h-7 px-2 py-0.5 border-b border-border/50",
    cell: cn(dConfig.cellClass, "overflow-hidden align-middle"),
    row: cn(dConfig.rowClass, "table-row-hover border-border/30 border-b"),
    sortIcon: "h-3 w-3",
  };

  // Signature of currently-visible columns so memoized rows re-render when the
  // user toggles or reorders columns (row.original alone wouldn't change).
  const columnsKey = table
    .getVisibleLeafColumns()
    .map((c) => c.id)
    .join(",");

  // Helper to render status rows (loading, error, empty)
  const renderStatusRow = (content: ReactNode, height = "h-16") => (
    <TableRow>
      <TableCell
        colSpan={table.getAllColumns().length + (isDebugEnabled ? 1 : 0)}
        className={cn("text-center", height)}
      >
        {content}
      </TableCell>
    </TableRow>
  );

  // Render table body content based on state
  const renderTableBody = () => {
    if (isLoading) {
      return renderStatusRow(<SimpleLoading />);
    }

    if (error) {
      return renderStatusRow(<ErrorDisplay error={error} />);
    }

    if (!rows.length) {
      const state = table.getState();
      const isFiltered = hasActiveFilters(
        state.columnFilters,
        state.globalFilter as string | undefined,
      );
      const clearFilters = isFiltered
        ? () => {
            table.resetColumnFilters();
            table.setGlobalFilter("");
          }
        : undefined;
      const emptyContent = entity ? (
        <EntityEmptyState
          entity={entity}
          isFiltered={isFiltered}
          onClearFilters={clearFilters}
        />
      ) : (
        <EntityEmptyState
          entity="product"
          isFiltered={true}
          onClearFilters={clearFilters}
        />
      );
      return renderStatusRow(emptyContent, "h-24");
    }

    const colSpan = table.getAllColumns().length + (isDebugEnabled ? 1 : 0);

    // Always use virtualized rendering for consistent behavior
    return (
      <>
        {/* Top padding row for scroll position. Window-virtualizer offsets are
            measured from the document top, so subtract the table's scrollMargin
            to get the gap within the table body. */}
        {virtualRows.length > 0 && virtualRows[0]!.start - scrollMargin > 0 && (
          <tr>
            <td
              colSpan={colSpan}
              className="border-0 p-0"
              style={{
                height: `${virtualRows[0]!.start - scrollMargin}px`,
                ...ghostRowsStyle(dConfig.rowHeight),
              }}
            />
          </tr>
        )}

        {/* Render only visible rows (with optional group headers) */}
        {virtualRows.map((virtualRow) => {
          const item = resolveIndex(virtualRow.index);
          if (item.kind === "header") {
            return (
              <TableRow
                key={`group-${item.title}`}
                className="border-border/30 border-b"
                style={{ height: `${virtualRow.size}px` }}
              >
                <TableCell colSpan={colSpan} className="p-0">
                  <SectionHeader
                    title={item.title}
                    count={item.count}
                    color={item.color}
                  />
                </TableCell>
              </TableRow>
            );
          }
          // rowIndex is a valid position into the rows array (flat index when
          // ungrouped, or the row's flat index when grouped).
          const row = rows[item.rowIndex]!;
          return (
            <DataRow
              key={row.id}
              row={row}
              isSelected={row.getIsSelected()}
              isFocused={focusedRowIndex === row.index}
              isDebugEnabled={isDebugEnabled}
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              rowClassName={cn(styles.row, getRowClassName?.(row))}
              cellClassName={styles.cell}
              columnsKey={columnsKey}
              height={`${virtualRow.size}px`}
            />
          );
        })}

        {/* Bottom padding row for remaining scroll space */}
        {virtualRows.length > 0 && (
          <tr>
            <td
              colSpan={colSpan}
              className="border-0 p-0"
              style={{
                height: `${totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0)}px`,
                ...ghostRowsStyle(dConfig.rowHeight),
              }}
            />
          </tr>
        )}
      </>
    );
  };

  return (
    <SpacedContainer space={4}>
      {/* Desktop Table View - Unified wrapper. Sets the entity-inked
          --row-accent so hover/selected bars match the section's color. */}
      {!isMobile && (
        <div
          className="border-[var(--border-chunky)] border-y"
          style={
            {
              ...(entity ? { "--row-accent": ENTITY_ACCENTS[entity] } : {}),
              // Header pins below the nav + the (dynamic) sticky toolbar.
              "--table-header-top": `${NAV_HEIGHT + toolbarHeight}px`,
            } as React.CSSProperties
          }
        >
          {/* Sticky toolbar — pins just below the top nav. Holds view options,
              filters reset, the bulk-action bar, and a page-size control. */}
          <div
            ref={toolbarRef}
            className="sticky top-16 z-30 border-border/50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
          >
            <DataTableToolbar
              table={table}
              additionalContent={
                <div className="flex items-center gap-2">
                  {additionalToolbarContent}
                  {groupConfig && onGroupedChange && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 shrink-0 p-0"
                      onClick={() => onGroupedChange(!grouped)}
                      aria-label={
                        grouped ? "Show flat list" : "Show grouped list"
                      }
                    >
                      {grouped ? (
                        <List className="h-4 w-4" />
                      ) : (
                        <LayoutList className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  <RowsPerPageSelect table={table} className="h-7 w-16" />
                </div>
              }
              actions={actions}
              bulkActionBar={bulkActionBar}
              className="px-3 py-2"
            />
          </div>

          {/* Table wrapper. No longer scrolls (the window does) — kept as the
              scrollMargin anchor and the focus target for keyboard row nav. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hosts keyboard row navigation (arrow keys/Enter), not a semantic control */}
          <div
            ref={tableContainerRef}
            className="outline-none"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard row navigation requires focusable container
            tabIndex={0}
            onKeyDown={(e) => {
              if (
                e.key === "ArrowDown" ||
                e.key === "ArrowUp" ||
                e.key === "Enter"
              ) {
                e.preventDefault();
                const rowCount = rows.length;
                if (rowCount === 0) return;

                if (
                  e.key === "Enter" &&
                  focusedRowIndex !== null &&
                  onRowClick
                ) {
                  const row = rows[focusedRowIndex];
                  if (row) onRowClick(row);
                  return;
                }

                const next =
                  focusedRowIndex === null
                    ? 0
                    : e.key === "ArrowDown"
                      ? Math.min(focusedRowIndex + 1, rowCount - 1)
                      : Math.max(focusedRowIndex - 1, 0);
                setFocusedRowIndex(next);
                // When grouped, the virtualizer's index space includes header
                // items, so map the flat row index to its virtualizer index.
                const targetIndex = flatRowToVirtualIndex(next);
                if (targetIndex >= 0) {
                  scrollToIndex(targetIndex, { align: "auto" });
                }
              }
              if (e.key === "Escape") {
                setFocusedRowIndex(null);
              }
            }}
          >
            <Table
              aria-label={ariaLabel}
              className={cn(styles.table)}
              containerClassName="overflow-visible"
            >
              <TableHeader
                className="sticky z-20 bg-background shadow-[var(--shadow-chunky-sm)] [&_tr]:border-b-0"
                style={{ top: "var(--table-header-top)" }}
              >
                {table.getHeaderGroups().map((headerGroup) => {
                  // Check if any column has a filter config
                  const hasAnyFilters = headerGroup.headers.some(
                    (h) => h.column.columnDef.meta?.filterConfig,
                  );

                  return (
                    <Fragment key={headerGroup.id}>
                      {/* Title Row */}
                      <TableRow
                        className={cn(
                          "border-border/50 border-b-0",
                          !hasAnyFilters && "border-b",
                        )}
                      >
                        {headerGroup.headers.map((header) => {
                          const sortDirection = header.column.getIsSorted();
                          const canSort = header.column.getCanSort();
                          const sortingArrows =
                            sortDirection === "desc" ? (
                              <ArrowDown
                                className={styles.sortIcon}
                                aria-hidden="true"
                              />
                            ) : sortDirection === "asc" ? (
                              <ArrowUp
                                className={styles.sortIcon}
                                aria-hidden="true"
                              />
                            ) : canSort ? (
                              <ArrowUpDown
                                className={cn(
                                  styles.sortIcon,
                                  "opacity-40 group-hover:opacity-100",
                                )}
                                aria-hidden="true"
                              />
                            ) : null;

                          const titleContent = (
                            <>
                              {header.isPlaceholder
                                ? null
                                : flexRender(
                                    header.column.columnDef.header,
                                    header.getContext(),
                                  )}
                              {sortingArrows}
                            </>
                          );

                          return (
                            <TableHead
                              key={header.id}
                              colSpan={header.colSpan}
                              aria-sort={
                                sortDirection === "asc"
                                  ? "ascending"
                                  : sortDirection === "desc"
                                    ? "descending"
                                    : "none"
                              }
                              className={cn(
                                header.column.columnDef.meta?.className,
                                styles.header,
                                sortDirection && "bg-muted/50",
                              )}
                            >
                              {canSort ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="group -ml-2 h-6 justify-start gap-1 px-2 font-semibold text-2xs uppercase tracking-wider hover:bg-muted/60"
                                  onClick={() =>
                                    header.column.toggleSorting(
                                      header.column.getIsSorted() === "asc",
                                    )
                                  }
                                >
                                  {titleContent}
                                </Button>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  {titleContent}
                                </span>
                              )}
                            </TableHead>
                          );
                        })}
                        {isDebugEnabled && (
                          <TableHead className={cn(styles.header)}>
                            Debug
                          </TableHead>
                        )}
                      </TableRow>

                      {/* Filter Row - only render if any column has filters */}
                      {hasAnyFilters && (
                        <TableRow
                          key={`${headerGroup.id}-filters`}
                          className={styles.filterRow}
                        >
                          {headerGroup.headers.map((header) => {
                            const filterConfig =
                              header.column.columnDef.meta?.filterConfig;

                            return (
                              <TableHead
                                key={`${header.id}-filter`}
                                colSpan={header.colSpan}
                                className={cn(
                                  header.column.columnDef.meta?.className,
                                  styles.filterRow,
                                )}
                              >
                                {filterConfig && (
                                  <HeaderFilter
                                    column={header.column}
                                    filterConfig={filterConfig}
                                  />
                                )}
                              </TableHead>
                            );
                          })}
                          {isDebugEnabled && (
                            <TableHead className={cn(styles.filterRow)} />
                          )}
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableHeader>
              <TableBody>{renderTableBody()}</TableBody>
              {/* Footer aggregation row — only when data is loaded */}
              {rows.length > 0 &&
                (() => {
                  const footerGroups = table.getFooterGroups();
                  const hasFooter = footerGroups.some((fg) =>
                    fg.headers.some((h) => h.column.columnDef.footer),
                  );
                  if (!hasFooter) return null;
                  return (
                    <TableFooter className="border-t bg-card font-medium text-xs">
                      {footerGroups.map((footerGroup) => (
                        <TableRow
                          key={footerGroup.id}
                          className="hover:bg-muted/50"
                        >
                          {footerGroup.headers.map((header) => (
                            <TableCell
                              key={header.id}
                              colSpan={header.colSpan}
                              className={cn(
                                "px-2 py-1.5",
                                header.column.columnDef.meta?.className,
                              )}
                            >
                              {header.isPlaceholder
                                ? null
                                : flexRender(
                                    header.column.columnDef.footer,
                                    header.getContext(),
                                  )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableFooter>
                  );
                })()}
            </Table>
          </div>
        </div>
      )}

      {/* Mobile List View */}
      {isMobile && (
        <MobileListScreen
          table={table}
          entity={entity}
          additionalToolbarContent={additionalToolbarContent}
          actions={actions}
          bulkActionBar={bulkActionBar}
          isLoading={isLoading}
          error={error}
          renderMobileCard={renderMobileCard}
          swipeActions={swipeActions}
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
          groupConfig={groupConfig}
          grouped={grouped}
          onGroupedChange={onGroupedChange}
        />
      )}

      {/* Desktop: persistent pagination/status bar pinned to the viewport
          bottom (page-size + page nav stay reachable without scrolling). */}
      {!isMobile && (
        <div className="sticky bottom-0 z-30 border-[var(--border-chunky)] border-t bg-background/90 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <DataTablePagination table={table} timing={timing} />
        </div>
      )}

      {/* Mobile keeps the inline pager, hidden when infinite scroll is active */}
      {isMobile && table.getPageCount() > 1 && !infiniteScroll && (
        <DataTablePagination table={table} timing={timing} />
      )}
    </SpacedContainer>
  );
}
