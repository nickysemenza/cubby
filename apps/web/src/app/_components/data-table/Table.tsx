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
import { CellSelectionContext } from "./cell-selection-context";
import { DesktopDataRow as DataRow } from "./DesktopDataRow";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableToolbar } from "./data-table-toolbar";
import {
  EntityEmptyState,
  FilteredEmptyState,
  hasActiveFilters,
  isNarrowed,
} from "./entity-empty-states";
import { HeaderFilter } from "./HeaderFilter";
import { MobileListScreen } from "./MobileListScreen";
import { RowsPerPageSelect } from "./rows-per-page-select";
import { SectionHeader } from "./SectionHeader";
import { useDataTableController } from "./useDataTableController";
import type { GroupConfig } from "./useGroupedList";
import { useTableColumnSizing } from "./useTableColumnSizing";

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
  /**
   * Keep the column-visibility menu (and therefore the toolbar) on an
   * `embedded` table. Opt-in: it only earns its row of chrome when the table
   * actually carries optional columns, which is the difference between "the
   * View menu holds nothing" and "these columns are unreachable without it".
   * Ignored when not embedded — the full toolbar already shows the menu.
   */
  showColumnMenu?: boolean;
  /**
   * Replaces the entity empty state when there are no rows.
   *
   * The stock state is page-level copy that invites creating one of these
   * ("Nothing on the shelves yet" + an Add Product button) — right for a list
   * page, wrong for an embedded section whose emptiness is about a
   * relationship ("no products bought from this vendor"). Callers that own
   * their own search/scope also own the honest wording, so this always wins
   * when provided.
   */
  emptyState?: ReactNode;
  /**
   * localStorage key for this table's persisted column widths. Defaults to
   * `entity`, which covers every list page; pass it explicitly for a table with
   * no single entity (the global search table) or for a second table over the
   * same entity with a different column set (`"task:embedded"`). A table with
   * neither `entity` nor `sizingKey` simply isn't resizable.
   */
  sizingKey?: string;
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
    showColumnMenu = false,
    emptyState,
    sizingKey,
  } = props;

  // Column widths are owned here rather than threaded through table meta, so
  // every RTable surface is resizable — including the hand-wired ones that
  // don't go through useEntityList.
  const { columnSizing, setColumnSize, resetColumnSize, resetAllColumnSizes } =
    useTableColumnSizing(sizingKey ?? entity);

  const {
    cellSelectionContainerProps,
    colSpan,
    columnsKey,
    dConfig,
    focusedRowIndex,
    getRowCellSelection,
    hydrated,
    isDebugEnabled,
    isFetchingNextPage,
    isTransitioning,
    isMobile,
    paneWrapperRef,
    paneMaxHeight,
    resolveIndex,
    rows,
    rowContentVersion,
    setDesktopInfiniteSentinel,
    styles,
    tableContainerRef,
    totalSize,
    virtualRows,
  } = useDataTableController({
    table,
    infiniteScroll,
    groupConfig,
    grouped,
    verticalAlign,
    onRowClick,
  });

  // Desktop tables get spreadsheet-style cell selection; mobile does not.
  const cellSelectionEnabled = !isMobile && !isTransitioning;

  // Embedded tables drop chrome that would carry no information: a toolbar
  // holding only the View menu + page-size control, and a pager for a list that
  // fits on one page (the rule mobile already applies to its inline pager).
  // `showColumnMenu` is the opt-out: a table with optional columns needs the
  // View menu at rest, not only once rows are selected (`bulkActionBar` is null
  // until then, which is what made those columns unreachable).
  const showToolbar =
    !embedded ||
    showColumnMenu ||
    Boolean(
      actions ?? bulkActionBar ?? additionalToolbarContent ?? groupConfig,
    );
  const showPagination = !embedded || table.getPageCount() > 1;

  // Loading / error / empty content, or null when real rows should render.
  //
  // This deliberately does NOT render inside a `<td colSpan>`. A full-width
  // cell is as wide as the table's SCROLL width, so `text-center` centres
  // against ~2288px on a wide list and lands the headline — and the only
  // "Clear filters" escape from a zero-result dead end — past the right edge
  // of a 1280px viewport. Status is page state, not row data, so it renders as
  // a block outside the table where the container's width bounds it.
  const renderStatusContent = (): ReactNode => {
    if (isLoading || !hydrated) return <SimpleLoading />;

    if (error) return <ErrorDisplay error={error} />;

    if (!rows.length) {
      if (emptyState) return emptyState;
      const state = table.getState();
      // Narrowed-ness and clearability part ways when a URL-only scope is on:
      // the copy must say "no matches", but only column filters are resettable
      // from here (see `isNarrowed`).
      const isFiltered = isNarrowed(table);
      const clearFilters = hasActiveFilters(state.columnFilters)
        ? () => {
            table.resetColumnFilters();
          }
        : undefined;
      return entity ? (
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
    }

    return null;
  };

  const statusContent = renderStatusContent();

  const renderTableBody = () => {
    // Status is rendered as a block below the table (see renderStatusContent),
    // so the body stays empty rather than holding a full-scroll-width cell.
    if (statusContent !== null) return null;

    // Always use virtualized rendering for consistent behavior
    const topSpacerHeight = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
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
        {/* Top padding row for scroll position. Offsets are relative to the
            table's own scroll pane, so `start` is already the gap. */}
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
              rowIndex={item.rowIndex}
              isSelected={row.getIsSelected()}
              isExpanded={row.getIsExpanded()}
              // Flat-index compare: focusedRowIndex is the selection's focus row
              // in the same `rows` space as item.rowIndex (row.index can diverge
              // under grouping/expansion).
              isFocused={focusedRowIndex === item.rowIndex}
              isDebugEnabled={isDebugEnabled}
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              cellSelection={getRowCellSelection(item.rowIndex)}
              suppressCellRowClick={cellSelectionEnabled}
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
              rowContentVersion={rowContentVersion}
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
          --row-accent so hover/selected bars match the section's color. The
          provider tells editable cells (CellEditTrigger) to select-then-edit
          rather than click-to-edit. */}
      {!isMobile && (
        <CellSelectionContext.Provider value={cellSelectionEnabled}>
          <div
            ref={paneWrapperRef}
            // `hidden md:flex` rather than JS alone: before hydration
            // `useIsMobile` must report false (the server has no viewport), so
            // both branches render on that first pass and the breakpoint — not
            // JS — decides. Without it a phone paints the clipped desktop
            // table under the mobile skeleton until hydration flips.
            //
            // A bounded flex column: toolbar and pager are fixed-height ends and
            // the pane between them takes the rest, so both stay on screen
            // without `position: sticky` and the rows scroll inside the table.
            className={cn(
              "hidden flex-col border-[var(--border)] md:flex",
              // A page-level table now sits flush against the rail and the
              // command header (the shell spends no gutter), so its own left
              // and top borders would double the rail's border and the
              // header's 3px ink rule. Drop them and let the page chrome BE
              // the table's edge; an embedded table floats in a section and
              // still needs all four.
              embedded ? "border" : "border-r border-b",
            )}
            style={
              {
                ...(entity ? { "--row-accent": ENTITY_ACCENTS[entity] } : {}),
                // Embedded tables sit in a scrolling detail page, so they take a
                // fixed ceiling instead of claiming the rest of the viewport.
                maxHeight: embedded
                  ? "60vh"
                  : paneMaxHeight != null
                    ? `${paneMaxHeight}px`
                    : undefined,
              } as React.CSSProperties
            }
          >
            {/* Toolbar — the column's fixed top end. Holds view options,
              filters reset, the bulk-action bar, and a page-size control. */}
            {showToolbar && (
              <div className="shrink-0 border-border border-b bg-background">
                <DataTableToolbar
                  table={table}
                  entity={entity}
                  ownsPageIdentity={!embedded}
                  onResetColumnWidths={
                    resetAllColumnSizes && Object.keys(columnSizing).length > 0
                      ? resetAllColumnSizes
                      : undefined
                  }
                  additionalContent={
                    // flex-wrap: an embedded table in the aside rail can't fit
                    // a search box, a summary, and the View menu on one line —
                    // without it they overlap instead of stacking.
                    <div className="flex flex-wrap items-center gap-2">
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
                            <List className="size-4" />
                          ) : (
                            <LayoutList className="size-4" />
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
                  isTransitioning={isTransitioning}
                  className="px-4 py-1"
                />
              </div>
            )}

            {/* The scroll pane: the virtualizer's scroll element, the focus
              target for keyboard cell nav, and the box the rows scroll inside
              on BOTH axes. Scrolling here rather than on the window is what
              keeps the nav rail, page header, toolbar and column header in
              place when a wide table is scrolled sideways.
              `min-h-0` is required — a flex child's default `min-height: auto`
              refuses to shrink below its content, which would push the pane
              past the wrapper's ceiling and hand the scroll back to the page.
              Cell selection (keyboard + mouse) is wired via containerProps;
              data-[cell-dragging] suppresses native text selection mid-drag. */}
            <div
              ref={tableContainerRef}
              className="min-h-0 flex-1 overflow-auto outline-none data-[cell-dragging]:select-none"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard cell navigation requires focusable container
              tabIndex={0}
              {...cellSelectionContainerProps}
            >
              <Table
                aria-label={ariaLabel}
                aria-busy={isTransitioning}
                className={cn(styles.table)}
                // The pane above owns scrolling for both axes; the primitive's
                // own `overflow-x-auto` here would nest a second scroller and
                // re-bind the sticky header to it.
                containerClassName="overflow-visible"
              >
                {/* Sticks to the pane's own top, so there is no offset to keep
                  in sync with the nav and toolbar heights. */}
                <TableHeader className="sticky top-0 z-30 bg-card shadow-[0_1px_0_var(--border)] [&_th]:bg-card [&_tr]:border-b-0">
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
                            const resizedWidth = columnSizing[header.column.id];
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
                                  // group/th: the resize handle only inks up
                                  // when its own header is hovered.
                                  "group/th relative",
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
                                    onCommit={setColumnSize}
                                    onReset={resetColumnSize}
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
                          {/* Trailing gutter, pinned to zero so the COLUMNS get
                            the table's leftover width. Left unsized it's the
                            only auto cell under `table-fixed`, so it swallows
                            every surplus pixel and the columns sit at exactly
                            their declared `w-*` — that's what left several
                            hundred px of dead space beside columns that were
                            clipping. At w-0 the surplus spreads across the
                            sized columns in proportion to their widths, so each
                            `w-*` reads as a share.

                            Only the HEADER spacer needs this — under
                            table-fixed the first row sizes every column, so the
                            body spacer (DesktopDataRow) stays untouched and row
                            memoization is unaffected. */}
                          <TableHead
                            data-spacer
                            aria-hidden
                            scope={undefined}
                            className={cn(styles.header, "w-0")}
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
                                  scope={undefined}
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
                              <TableHead
                                scope={undefined}
                                className={cn(styles.filterRow)}
                              />
                            )}
                            <TableHead
                              data-spacer
                              aria-hidden
                              scope={undefined}
                              className={styles.filterRow}
                            />
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableHeader>
                <TableBody
                  inert={isTransitioning ? true : undefined}
                  aria-disabled={isTransitioning || undefined}
                >
                  {renderTableBody()}
                </TableBody>
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
              {/* Status block. Sits outside <table> so its width is the
                container's, not the table's scroll width — that is what keeps
                the empty state's "Clear filters" reachable on a list wide
                enough to scroll. `sticky left-0` holds it in view if the page
                is already scrolled right when the rows empty out. */}
              {statusContent !== null && (
                <div className="sticky left-0 flex min-h-24 w-full items-center justify-center overflow-hidden px-2 py-4">
                  {statusContent}
                </div>
              )}
            </div>

            {/* The column's fixed bottom end. Page-size and page nav stay put
              while the pane scrolls between the two ends, so neither needs
              `position: sticky` to stay reachable. */}
            {!infiniteScroll && showPagination && (
              <div className="shrink-0 border-[var(--border)] border-t bg-background px-2 py-1">
                <DataTablePagination table={table} timing={timing} />
              </div>
            )}
          </div>
        </CellSelectionContext.Provider>
      )}

      {/* Mobile List View. Also rendered pre-hydration (see the desktop
          wrapper's breakpoint comment) so a phone's first paint is the
          shape-matched skeleton rather than a clipped desktop table. */}
      {(isMobile || !hydrated) && (
        <MobileListScreen
          table={table}
          entity={entity}
          ownsPageIdentity={!embedded}
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
          isTransitioning={isTransitioning}
          rowContentVersion={rowContentVersion}
        />
      )}

      {/* Mobile keeps the inline pager, hidden when infinite scroll is active */}
      {isMobile && table.getPageCount() > 1 && !infiniteScroll && (
        <DataTablePagination table={table} timing={timing} />
      )}
    </Stack>
  );
}
