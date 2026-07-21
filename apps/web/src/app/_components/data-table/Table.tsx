// cf https://ui.shadcn.com/docs/components/data-table

import type { Entity } from "@cubby/schemas/entity";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  LayoutList,
  List,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Stack } from "~/components/layout";
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
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { DesktopDataRow as DataRow } from "./DesktopDataRow";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableToolbar } from "./data-table-toolbar";
import {
  EntityEmptyState,
  FilteredEmptyState,
  hasActiveFilters,
} from "./entity-empty-states";
import { HeaderFilter } from "./HeaderFilter";
import { MobileListScreen } from "./MobileListScreen";
import { RowsPerPageSelect } from "./rows-per-page-select";
import { SectionHeader } from "./SectionHeader";
import { useDataTableController } from "./useDataTableController";
import type { GroupConfig } from "./useGroupedList";

// Sticky top nav height: the h-12 (48px) nav bar + its 3px ink bottom-rule =
// 51px (see __root.tsx). The sticky toolbar pins flush below it; if these drift
// apart a sliver of scrolled rows peeks through the seam. Keep `top-[51px]` on
// the toolbar in sync with this constant.
const NAV_HEIGHT = 51;

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
  /**
   * Vertical alignment of cell content (desktop). Defaults to `"middle"`. Use
   * `"top"` for grids with multi-line cells (e.g. an ingredient name stacked
   * over its raw line) so single-value cells align to the row's headline value
   * instead of floating at its centre.
   */
  verticalAlign?: "top" | "middle";
  /**
   * Table is nested inside a detail-page section rather than owning the page.
   * Drops the page-level sticky chrome (toolbar / column header / pagination
   * bar), which otherwise floats over the section's own rows, and hides the
   * toolbar and pager entirely when they'd hold nothing but the View menu and
   * a one-page pager.
   */
  embedded?: boolean;
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
    onRowClick,
    onRowHover,
    infiniteScroll,
    refreshControls,
    groupConfig,
    grouped = false,
    onGroupedChange,
    getRowClassName,
    verticalAlign = "middle",
    embedded = false,
  } = props;

  const {
    colSpan,
    columnsKey,
    dConfig,
    flatRowToVirtualIndex,
    focusedRowIndex,
    hydrated,
    isDebugEnabled,
    isFetchingNextPage,
    isMobile,
    resolveIndex,
    rows,
    scrollMargin,
    scrollToIndex,
    setDesktopInfiniteSentinel,
    setFocusedRowIndex,
    styles,
    tableContainerRef,
    toolbarHeight,
    toolbarRef,
    totalSize,
    virtualRows,
  } = useDataTableController({
    table,
    infiniteScroll,
    groupConfig,
    grouped,
    verticalAlign,
  });

  // Embedded tables drop chrome that would carry no information: a toolbar
  // holding only the View menu + page-size control, and a pager for a list that
  // fits on one page (the rule mobile already applies to its inline pager).
  const showToolbar =
    !embedded ||
    Boolean(
      actions ?? bulkActionBar ?? additionalToolbarContent ?? groupConfig,
    );
  const showPagination = !embedded || table.getPageCount() > 1;

  // Helper to render status rows (loading, error, empty)
  const renderStatusRow = (content: ReactNode, height = "h-16") => (
    <TableRow>
      <TableCell colSpan={colSpan} className={cn("text-center", height)}>
        {content}
      </TableCell>
    </TableRow>
  );

  // Render table body content based on state
  const renderTableBody = () => {
    if (isLoading || !hydrated) {
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
        // No entity known: render an honest generic empty state with the real
        // filter flag, rather than masquerading as a filtered product table.
        <FilteredEmptyState
          isFiltered={isFiltered}
          onClearFilters={clearFilters}
        />
      );
      return renderStatusRow(emptyContent, "h-24");
    }

    // Always use virtualized rendering for consistent behavior
    const topSpacerHeight =
      virtualRows.length > 0 ? virtualRows[0]!.start - scrollMargin : 0;
    const bottomSpacerHeight =
      virtualRows.length > 0
        ? Math.max(
            0,
            totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0),
          )
        : 0;
    const bottomSpacerStyle = infiniteScroll
      ? undefined
      : ghostRowsStyle(dConfig.rowHeight);

    return (
      <>
        {/* Top padding row for scroll position. Window-virtualizer offsets are
            measured from the document top, so subtract the table's scrollMargin
            to get the gap within the table body. */}
        {topSpacerHeight > 0 && (
          <tr>
            <td
              colSpan={colSpan}
              className="border-0 p-0"
              style={{
                height: `${topSpacerHeight}px`,
                ...ghostRowsStyle(dConfig.rowHeight),
              }}
            />
          </tr>
        )}

        {/* Render only visible rows (with optional group headers) */}
        {virtualRows.map((virtualRow) => {
          const item = resolveIndex(virtualRow.index);
          if (item.kind === "sentinel") {
            return (
              <TableRow
                key="infinite-sentinel"
                className="border-border border-b bg-background"
                style={{ height: `${virtualRow.size}px` }}
              >
                <TableCell
                  colSpan={colSpan}
                  className="text-center text-muted-foreground text-xs"
                >
                  <div ref={setDesktopInfiniteSentinel} className="h-px" />
                  {isFetchingNextPage ? "Loading more..." : null}
                </TableCell>
              </TableRow>
            );
          }
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
              isExpanded={row.getIsExpanded()}
              isFocused={focusedRowIndex === row.index}
              isDebugEnabled={isDebugEnabled}
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              rowClassName={cn(
                styles.row,
                // Zebra keyed off the flat row index, not nth-child: the body
                // is window-virtualized behind a spacer <tr>, so DOM-child
                // parity shifts as the window scrolls. In grouped mode the
                // within-group index restarts stripes at each section header.
                (item.groupRowIndex ?? item.rowIndex) % 2 === 1 &&
                  "table-row-zebra",
                getRowClassName?.(row),
              )}
              cellClassName={styles.cell}
              columnsKey={columnsKey}
              height={`${virtualRow.size}px`}
            />
          );
        })}

        {/* Bottom padding row for remaining scroll space */}
        {bottomSpacerHeight > 0 && (
          <tr>
            <td
              colSpan={colSpan}
              className="border-0 p-0"
              style={{
                height: `${bottomSpacerHeight}px`,
                ...bottomSpacerStyle,
              }}
            />
          </tr>
        )}
      </>
    );
  };

  return (
    // max-w-[90rem]: self-cap at the 2xl page width. Most list pages are
    // already capped by PageWrapper, but fullWidth hosts (locations' tabbed
    // page, sized for its gallery view) would otherwise stretch the table to
    // the viewport and the width-slack spacer into an absurd gutter.
    <Stack className="max-w-[90rem]">
      {/* Desktop Table View - Unified wrapper. Sets the entity-inked
          --row-accent so hover/selected bars match the section's color. */}
      {!isMobile && (
        <div
          className="border border-[var(--border)]"
          style={
            {
              ...(entity ? { "--row-accent": ENTITY_ACCENTS[entity] } : {}),
              // Header pins below the nav + the (dynamic) sticky toolbar.
              // Embedded tables aren't sticky at all, so the var is moot.
              ...(embedded
                ? {}
                : { "--table-header-top": `${NAV_HEIGHT + toolbarHeight}px` }),
            } as React.CSSProperties
          }
        >
          {/* Sticky toolbar — pins just below the top nav. Holds view options,
              filters reset, the bulk-action bar, and a page-size control. */}
          {showToolbar && (
            <div
              ref={toolbarRef}
              className={cn(
                "border-border border-b bg-background",
                !embedded && "sticky top-[51px] z-40",
              )}
            >
              <DataTableToolbar
                table={table}
                additionalContent={
                  <div className="flex items-center gap-2">
                    {additionalToolbarContent}
                    {groupConfig && onGroupedChange && (
                      <Button
                        variant="ghost"
                        size="icon-lg"
                        className="shrink-0"
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
                    {!infiniteScroll && (
                      <RowsPerPageSelect table={table} className="h-7 w-16" />
                    )}
                  </div>
                }
                actions={actions}
                bulkActionBar={bulkActionBar}
                className="px-4 py-1"
              />
            </div>
          )}

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
                className={cn(
                  "bg-card shadow-[0_1px_0_var(--border)] [&_th]:bg-card [&_tr]:border-b-0",
                  !embedded && "sticky z-30",
                )}
                style={
                  embedded ? undefined : { top: "var(--table-header-top)" }
                }
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
                          const numeric =
                            header.column.columnDef.meta?.numeric ?? false;
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
                              {/* Sort-stack position (1-based) — only shown
                                  when 2+ columns are stacked via shift-click */}
                              {sortDirection &&
                                table.getState().sorting.length > 1 && (
                                  <span className="text-3xs text-muted-foreground tabular-nums">
                                    {header.column.getSortIndex() + 1}
                                  </span>
                                )}
                            </>
                          );

                          // User-resized width (persisted): under table-fixed,
                          // sizing the header cell drives the whole column.
                          const resizedWidth =
                            table.options.meta?.columnSizing?.[
                              header.column.id
                            ];
                          const isResizable =
                            header.column.id !== "select" &&
                            header.column.id !== "actions";
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
                                "relative",
                                styles.header,
                                numeric && "text-right",
                                header.column.columnDef.meta?.className,
                                sortDirection && "bg-muted/50",
                              )}
                              style={
                                resizedWidth
                                  ? {
                                      width: resizedWidth,
                                      minWidth: resizedWidth,
                                      maxWidth: resizedWidth,
                                    }
                                  : undefined
                              }
                            >
                              {canSort ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={cn(
                                    // select-none: shift-click (multi-sort) must
                                    // not start a text selection
                                    "group h-6 select-none gap-1 px-2 font-semibold text-2xs uppercase tracking-wider hover:bg-muted/60",
                                    // Mirror the cell's right-align: pull the label
                                    // to the column's right edge for numeric cols,
                                    // else keep the left-edge compensation.
                                    numeric
                                      ? "-mr-2 justify-end"
                                      : "-ml-2 justify-start",
                                  )}
                                  // Canonical TanStack handler: routes
                                  // shift-click through isMultiSortEvent so
                                  // stacked sorts work without custom logic.
                                  onClick={header.column.getToggleSortingHandler()}
                                >
                                  {titleContent}
                                </Button>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  {titleContent}
                                </span>
                              )}
                              {isResizable && (
                                <ColumnResizeHandle
                                  columnId={header.column.id}
                                  meta={table.options.meta}
                                />
                              )}
                            </TableHead>
                          );
                        })}
                        {isDebugEnabled && (
                          <TableHead className={cn(styles.header)}>
                            Debug
                          </TableHead>
                        )}
                        <TableHead
                          data-spacer
                          aria-hidden
                          className={styles.header}
                        />
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
                          <TableHead
                            data-spacer
                            aria-hidden
                            className={styles.filterRow}
                          />
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableHeader>
              <TableBody>{renderTableBody()}</TableBody>
              {/* Footer aggregation row — only when data is loaded. Renders in
                  infinite mode too: footers read server totals from table meta
                  (see serverTotals), so they no longer depend on having every
                  row loaded client-side. */}
              {rows.length > 0 &&
                (() => {
                  const footerGroups = table.getFooterGroups();
                  const hasFooter = footerGroups.some((fg) =>
                    fg.headers.some((h) => h.column.columnDef.footer),
                  );
                  if (!hasFooter) return null;
                  return (
                    <TableFooter className="border-t bg-card font-medium text-sm">
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
                                "px-2 py-1",
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
                          <TableCell data-spacer aria-hidden />
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
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
          groupConfig={groupConfig}
          grouped={grouped}
          onGroupedChange={onGroupedChange}
        />
      )}

      {/* Desktop: persistent pagination/status bar pinned to the viewport
          bottom (page-size + page nav stay reachable without scrolling). */}
      {!isMobile && !infiniteScroll && showPagination && (
        <div
          className={cn(
            "border-[var(--border)] border-t bg-background px-2 py-1",
            !embedded && "sticky bottom-0 z-30",
          )}
        >
          <DataTablePagination table={table} timing={timing} />
        </div>
      )}

      {/* Mobile keeps the inline pager, hidden when infinite scroll is active */}
      {isMobile && table.getPageCount() > 1 && !infiniteScroll && (
        <DataTablePagination table={table} timing={timing} />
      )}
    </Stack>
  );
}
