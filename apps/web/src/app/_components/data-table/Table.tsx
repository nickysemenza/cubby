// cf https://ui.shadcn.com/docs/components/data-table

import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import { LayoutList, List } from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
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
import { MobileListScreen } from "./MobileListScreen";
import { RowsPerPageSelect } from "./rows-per-page-select";
import { SectionHeader } from "./SectionHeader";
import type { CubbyTable as ITable, CubbyRow as Row } from "./table-features";
import { columnWidthValue } from "./table-layout";
import { useDataTableController } from "./useDataTableController";
import type { GroupConfig } from "./useGroupedList";

const TableHeaderLayout = lazy(() => import("./TableHeaderLayout"));

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

interface TTableProps<TItem extends RowData> {
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
  /** Expense-ledger-only desktop selection count/sum/average status. */
  showCellSelectionStats?: boolean;
  /** Server-side facet counts for the table's filter controls. */
  filterOptionHints?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

export default function RTable<TItem extends RowData>(
  props: TTableProps<TItem>,
) {
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
    showCellSelectionStats = false,
    filterOptionHints,
  } = props;
  const {
    cellSelectionContainerProps,
    colSpan,
    columnSizeVars,
    columnsKey,
    dConfig,
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
  //
  // Deliberately NOT gated on `isTransitioning`. This flag is the interaction
  // MODEL — which gesture opens an editor (double-click vs click), and whether
  // a cell click suppresses the row's onClick — and a gesture that changes
  // under the user's hands mid-fetch is a bug, not a safety measure. The
  // range ENGINE is what must pause while placeholder rows stand in for a
  // query that's being replaced, and it is gated separately
  // (`useCellSelection({ enabled: !isMobile && !isTransitioning })` in
  // useDataTableController) — that is the part #560 needed. Gating the mode
  // too also flipped every editable cell back to the legacy per-element
  // clipboard registration for the length of each transition, which is exactly
  // the path `cell-edit-trigger` documents as unsafe once the range engine
  // owns copy/paste.
  const cellSelectionEnabled = !isMobile;

  // Embedded tables drop chrome that would carry no information: a toolbar
  // holding only the View menu + page-size control, and a pager for a list that
  // fits on one page (the rule mobile already applies to its inline pager).
  // A table with optional columns or filters needs its toolbar at rest, not
  // only once rows are selected (`bulkActionBar` is null until then).
  const hasFilterConfig = table
    .getAllLeafColumns()
    .some((column) => column.columnDef.meta?.filterConfig);
  const showToolbar =
    !embedded ||
    showColumnMenu ||
    Boolean(
      actions ??
        bulkActionBar ??
        additionalToolbarContent ??
        groupConfig ??
        hasFilterConfig,
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
      const state = table.state;
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
          const rowSelectionProjection = (
            ranges: typeof table.state.cellSelection,
          ) => {
            const focused = ranges.at(-1)?.focusRowId === row.id;
            const version = ranges
              .filter((range) => {
                const anchor = rows.findIndex(
                  (candidate) => candidate.id === range.anchorRowId,
                );
                const focus = rows.findIndex(
                  (candidate) => candidate.id === range.focusRowId,
                );
                return (
                  anchor >= 0 &&
                  focus >= 0 &&
                  item.rowIndex >= Math.min(anchor, focus) &&
                  item.rowIndex <= Math.max(anchor, focus)
                );
              })
              .map(
                (range) =>
                  `${range.anchorColumnId}:${range.focusColumnId}:${range.operation ?? "include"}`,
              )
              .join("|");
            return { focused, version };
          };
          return (
            <table.Subscribe
              key={row.id}
              source={table.atoms.cellSelection!}
              selector={rowSelectionProjection}
            >
              {(selection) => (
                <table.Subscribe
                  source={table.atoms.rowSelection!}
                  selector={(selection) => selection[row.id] === true}
                >
                  {(isSelected) => (
                    <DataRow
                      row={row}
                      rowIndex={item.rowIndex}
                      isSelected={isSelected}
                      isExpanded={row.getIsExpanded()}
                      // Focus follows v9's durable focus corner and is subscribed at the
                      // row, not the virtualized body owner.
                      isFocused={selection.focused}
                      isDebugEnabled={isDebugEnabled}
                      onRowClick={onRowClick}
                      onRowHover={onRowHover}
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
                      selectionVersion={selection.version}
                      height={`${virtualRow.size}px`}
                    />
                  )}
                </table.Subscribe>
              )}
            </table.Subscribe>
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
    // already capped by Page, but wide hosts (locations' tabbed
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
                  filterOptionHints={filterOptionHints}
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
                style={columnSizeVars}
              >
                {/* Sticks to the pane's own top, so there is no offset to keep
                  in sync with the nav and toolbar heights. */}
                <TableHeader className="sticky top-0 z-30 bg-card shadow-[0_1px_0_var(--border)] [&_th]:bg-card [&_tr]:border-b-0">
                  <Suspense fallback={null}>
                    <TableHeaderLayout
                      table={table as unknown as ITable<RowData>}
                      styles={styles}
                      isDebugEnabled={isDebugEnabled}
                    />
                  </Suspense>
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
                    const startFooterGroups = table.getStartFooterGroups();
                    const centerFooterGroups = table.getCenterFooterGroups();
                    const endFooterGroups = table.getEndFooterGroups();
                    const footerGroups = Array.from(
                      {
                        length: Math.max(
                          startFooterGroups.length,
                          centerFooterGroups.length,
                          endFooterGroups.length,
                        ),
                      },
                      (_, index) => ({
                        id: `footer-${index}`,
                        headers: [
                          ...(startFooterGroups[index]?.headers ?? []),
                          ...(centerFooterGroups[index]?.headers ?? []),
                          ...(endFooterGroups[index]?.headers ?? []),
                        ],
                      }),
                    );
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
                            {footerGroup.headers.map((header) => {
                              const pinned = header.column.getIsPinned();
                              const width = columnWidthValue(header.column.id);
                              const pinnedColumns =
                                pinned === "start"
                                  ? table.getStartVisibleLeafColumns()
                                  : pinned === "end"
                                    ? table.getEndVisibleLeafColumns()
                                    : [];
                              const pinnedIndex = pinnedColumns.findIndex(
                                (column) => column.id === header.column.id,
                              );
                              const boundaryClass =
                                pinned === "start" &&
                                pinnedIndex === pinnedColumns.length - 1
                                  ? "shadow-[var(--shadow-pin-start)]"
                                  : pinned === "end" && pinnedIndex === 0
                                    ? "shadow-[var(--shadow-pin-end)]"
                                    : undefined;
                              return (
                                <TableCell
                                  key={header.id}
                                  colSpan={header.colSpan}
                                  className={cn(
                                    "px-2 py-1",
                                    header.column.columnDef.meta?.className,
                                    pinned && "sticky z-20 bg-card",
                                    boundaryClass,
                                  )}
                                  style={{
                                    width,
                                    minWidth: width,
                                    maxWidth: width,
                                    ...(pinned === "start"
                                      ? {
                                          insetInlineStart:
                                            header.column.getStart("start"),
                                        }
                                      : pinned === "end"
                                        ? {
                                            insetInlineEnd:
                                              header.column.getAfter("end"),
                                          }
                                        : {}),
                                  }}
                                >
                                  {header.isPlaceholder
                                    ? null
                                    : flexRender(
                                        header.column.columnDef.footer,
                                        header.getContext(),
                                      )}
                                </TableCell>
                              );
                            })}
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
            {((!infiniteScroll && showPagination) ||
              showCellSelectionStats) && (
              <div className="shrink-0 border-[var(--border)] border-t bg-background px-2 py-1">
                <DataTablePagination
                  table={table}
                  timing={timing}
                  showPaginationControls={!infiniteScroll && showPagination}
                  showCellSelectionStats={showCellSelectionStats}
                />
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
