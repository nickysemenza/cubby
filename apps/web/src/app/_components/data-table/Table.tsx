// cf https://ui.shadcn.com/docs/components/data-table

import type { Entity } from "@cubby/schemas/entity";
import { useThrottledValue } from "@tanstack/react-pacer";
import { useLocation } from "@tanstack/react-router";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { MobileListScreen } from "./MobileListScreen";
import { SectionHeader } from "./SectionHeader";
import { useDesktopGroupedRows } from "./useDesktopGroupedRows";
import type { GroupConfig } from "./useGroupedList";
import { densityConfig, useTableDensity } from "./useTableDensity";

// Scroll position cache for navigate-back restoration
const scrollPositionCache = new Map<string, number>();

// Number of rows to render outside the visible area
const OVERSCAN = 5;
// Minimum table height so it's always usable
const MIN_TABLE_HEIGHT = 300;
// Breathing room below the table
const BOTTOM_PADDING = 32;

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
  /** Callback when a row is clicked */
  onRowClick?: (row: Row<TItem>) => void;
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
}

interface DataRowProps<TItem> {
  row: Row<TItem>;
  isSelected: boolean;
  isFocused: boolean;
  isDebugEnabled: boolean;
  onRowClick?: (row: Row<TItem>) => void;
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
    onRowClick,
    infiniteScroll,
    refreshControls,
    groupConfig,
    grouped = false,
    onGroupedChange,
  } = props;

  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();
  const pathname = useLocation({ select: (l) => l.pathname });
  const { density } = useTableDensity();
  const dConfig = densityConfig[density];

  // Ref for virtualization scroll container
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation: focused row index (desktop only)
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null);

  // Dynamic table height: fill remaining viewport on desktop. Track raw window
  // height in state and throttle it so a resize drag recomputes maxHeight at
  // most ~once per 100ms instead of on every resize event.
  const [maxHeight, setMaxHeight] = useState(600);
  const [winHeight, setWinHeight] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 0,
  );
  const [throttledWinHeight] = useThrottledValue(winHeight, { wait: 100 });

  useEffect(() => {
    if (isMobile) return;
    const onResize = () => setWinHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile]);

  useEffect(() => {
    const el = tableContainerRef.current;
    if (!el || isMobile) return;
    const rect = el.getBoundingClientRect();
    const available = throttledWinHeight - rect.top - BOTTOM_PADDING;
    setMaxHeight(Math.max(available, MIN_TABLE_HEIGHT));
  }, [throttledWinHeight, isMobile]);

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

  // Estimated height for section headers (smaller than data rows)
  const SECTION_HEADER_HEIGHT = 28;

  // Always virtualize for consistent rendering
  const virtualizerCount = groupedItems ? groupedItems.length : rows.length;
  const rowVirtualizer = useVirtualizer({
    count: virtualizerCount,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: (index) => {
      if (groupedItems && groupedItems[index].kind === "header") {
        return SECTION_HEADER_HEIGHT;
      }
      return dConfig.rowHeight;
    },
    overscan: OVERSCAN,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Save scroll position on unmount for navigate-back restoration
  const saveScrollPosition = useCallback(() => {
    const el = tableContainerRef.current;
    if (el && el.scrollTop > 0) {
      scrollPositionCache.set(pathname, el.scrollTop);
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
        tableContainerRef.current?.scrollTo(0, savedPosition);
      });
      hasRestoredRef.current = true;
    }
  }, [pathname, rows.length, isMobile]);

  const styles = {
    table: "text-xs leading-tight border-collapse border-spacing-0",
    header:
      "h-8 px-2 py-1 text-2xs font-mono font-semibold uppercase tracking-wider text-eyebrow bg-muted/50",
    filterRow: "h-7 px-2 py-0.5 bg-muted/30 border-b border-border/50",
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
        {/* Top padding row for scroll position */}
        {virtualRows.length > 0 && virtualRows[0].start > 0 && (
          <tr style={{ height: `${virtualRows[0].start}px` }} />
        )}

        {/* Render only visible rows (with optional group headers) */}
        {virtualRows.map((virtualRow) => {
          if (groupedItems) {
            const item = groupedItems[virtualRow.index];
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
            const row = rows[item.rowIndex];
            return (
              <DataRow
                key={row.id}
                row={row}
                isSelected={row.getIsSelected()}
                isFocused={focusedRowIndex === row.index}
                isDebugEnabled={isDebugEnabled}
                onRowClick={onRowClick}
                rowClassName={styles.row}
                cellClassName={styles.cell}
                columnsKey={columnsKey}
                height={`${virtualRow.size}px`}
              />
            );
          }
          const row = rows[virtualRow.index];
          return (
            <DataRow
              key={row.id}
              row={row}
              isSelected={row.getIsSelected()}
              isFocused={focusedRowIndex === row.index}
              isDebugEnabled={isDebugEnabled}
              onRowClick={onRowClick}
              rowClassName={styles.row}
              cellClassName={styles.cell}
              columnsKey={columnsKey}
              height={`${virtualRow.size}px`}
            />
          );
        })}

        {/* Bottom padding row for remaining scroll space */}
        {virtualRows.length > 0 && (
          <tr
            style={{
              height: `${totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0)}px`,
            }}
          />
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
          className="overflow-hidden rounded-lg border-2 border-[var(--border-chunky)] shadow-[var(--shadow-chunky)]"
          style={
            entity
              ? ({
                  "--row-accent": ENTITY_ACCENTS[entity].base,
                } as React.CSSProperties)
              : undefined
          }
        >
          {/* Attached Toolbar */}
          <DataTableToolbar
            table={table}
            additionalContent={
              groupConfig && onGroupedChange ? (
                <div className="flex items-center gap-2">
                  {additionalToolbarContent}
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
                </div>
              ) : (
                additionalToolbarContent
              )
            }
            actions={actions}
            bulkActionBar={bulkActionBar}
            className="border-border/50 border-b bg-muted/30 px-3 py-2"
          />

          {/* Scrollable container for virtualization */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: scroll container hosts keyboard row navigation (arrow keys/Enter), not a semantic control */}
          <div
            ref={tableContainerRef}
            className="overflow-auto outline-none"
            style={{ maxHeight: `${maxHeight}px` }}
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
                // items, so map the flat row index to its groupedItems index.
                const targetIndex = groupedItems
                  ? groupedItems.findIndex(
                      (it) => it.kind === "row" && it.rowIndex === next,
                    )
                  : next;
                if (targetIndex >= 0) {
                  rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
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
              <TableHeader className="sticky top-0 z-20 bg-background shadow-[0_1px_3px_rgba(58,53,48,0.08)] [&_tr]:border-b-0">
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
                                sortDirection && "bg-[oklch(0.95_0.03_30)]",
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
                    <TableFooter className="sticky bottom-0 border-t bg-muted/50 font-medium text-xs">
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
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
          groupConfig={groupConfig}
          grouped={grouped}
          onGroupedChange={onGroupedChange}
        />
      )}

      {/* Hide pagination on mobile when infinite scroll is active */}
      {table.getPageCount() > 1 && !(isMobile && infiniteScroll) && (
        <DataTablePagination table={table} timing={timing} />
      )}
    </SpacedContainer>
  );
}
