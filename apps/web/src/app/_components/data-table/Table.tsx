// cf https://ui.shadcn.com/docs/components/data-table

import type { Entity } from "@cubby/schemas/entity";
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
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
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

// Scroll position cache for navigate-back restoration
const scrollPositionCache = new Map<string, number>();

// Estimated row height in pixels
const ESTIMATED_ROW_HEIGHT = 35;
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

  // Ref for virtualization scroll container
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Dynamic table height: fill remaining viewport on desktop
  const [maxHeight, setMaxHeight] = useState(600);

  useEffect(() => {
    const el = tableContainerRef.current;
    if (!el || isMobile) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const available = window.innerHeight - rect.top - BOTTOM_PADDING;
      setMaxHeight(Math.max(available, MIN_TABLE_HEIGHT));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isMobile]);

  // On desktop with infinite scroll, eagerly fetch all pages so client-side
  // pagination works over the complete dataset. Mobile uses scroll-to-load.
  useEffect(() => {
    if (
      !isMobile &&
      infiniteScroll?.hasNextPage &&
      !infiniteScroll.isFetchingNextPage
    ) {
      infiniteScroll.fetchNextPage();
    }
  }, [isMobile, infiniteScroll]);

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
      return ESTIMATED_ROW_HEIGHT;
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
    table:
      "text-xs leading-tight border-collapse border-spacing-0 [&_tr:nth-child(even)]:bg-[oklch(0.988_0.004_55)]",
    header: "h-8 px-2 py-1 text-xs font-medium text-foreground/80 bg-muted/30",
    filterRow: "h-7 px-2 py-0.5 bg-muted/30 border-b border-border/50",
    cell: "h-9 px-2 py-1 align-middle overflow-hidden",
    row: "h-9 table-row-hover border-b border-border/30",
    sortIcon: "h-3 w-3",
  };

  // Render a single row (virtualized)
  const renderRow = (row: Row<TItem>, style?: React.CSSProperties) => (
    <TableRow
      key={row.id}
      data-state={row.getIsSelected() && "selected"}
      className={cn(styles.row, onRowClick && "cursor-pointer")}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      style={style}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell
          key={cell.id}
          className={cn(styles.cell, cell.column.columnDef.meta?.className)}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
      {/* Add debug cell when debug mode is enabled */}
      {isDebugEnabled && (
        <TableCell className={cn(styles.cell)}>
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
            return renderRow(row, { height: `${virtualRow.size}px` });
          }
          const row = rows[virtualRow.index];
          return renderRow(row, { height: `${virtualRow.size}px` });
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
      {/* Desktop Table View - Unified wrapper */}
      {!isMobile && (
        <div className="overflow-hidden rounded-lg border border-border/50">
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
          <div
            ref={tableContainerRef}
            className="overflow-auto"
            style={{ maxHeight: `${maxHeight}px` }}
          >
            <Table
              aria-label={ariaLabel}
              className={cn(styles.table)}
              containerClassName="overflow-visible"
            >
              <TableHeader className="sticky top-0 z-20 bg-background [&_tr]:border-b-0">
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
                              )}
                            >
                              {canSort ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="group -ml-2 h-6 justify-start gap-1 px-2 font-medium text-xs hover:bg-muted/60"
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
