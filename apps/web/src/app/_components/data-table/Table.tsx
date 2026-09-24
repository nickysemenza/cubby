import type { Entity } from "@cubby/schemas/entity";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { ListIcon as List } from "@phosphor-icons/react/dist/csr/List";
import { ListDashesIcon as LayoutList } from "@phosphor-icons/react/dist/csr/ListDashes";
import type { CellSelectionState, RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo, useRef } from "react";

import { RecordSuggestionsProvider } from "~/app/_components/ai/record-suggestions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Stack } from "~/components/layout";
import {
  usePageIdentity,
  usePageWorkbenchTarget,
} from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";

import {
  type EntityActionsEntry,
  EntityActionsProvider,
  useEntityActions,
} from "../actions/entity-actions";
import { EntityDisplayImagesProvider } from "../entity-media/entity-display-images";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { CellSelectionContext } from "./cell-selection-context";
import { columnWidthValue } from "./column-layout";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableToolbar } from "./data-table-toolbar";
import { DesktopDataRow as DataRow } from "./DesktopDataRow";
import {
  EntityEmptyState,
  FilteredEmptyState,
  hasActiveFilters,
  isNarrowed,
} from "./entity-empty-states";
import { MobileListScreen } from "./MobileListScreen";
import { SectionHeader } from "./SectionHeader";
import { collectTableEntityMediaRefs } from "./table-entity-media";
import type { CubbyTable as ITable, CubbyRow as Row } from "./table-features";
import TableHeaderLayout from "./TableHeaderLayout";
import { useDataTableController } from "./useDataTableController";
import type { GroupConfig } from "./useGroupedList";

type DesktopPaneStyle = React.CSSProperties & {
  "--row-accent"?: string;
};

const tableChromeVariant = (embedded: boolean): "page" | "embedded" =>
  embedded ? "embedded" : "page";

function showMobileViewOptions({
  embedded,
  showColumnMenu,
  externalToolbar,
}: {
  embedded: boolean;
  showColumnMenu: boolean;
  externalToolbar: boolean;
}): boolean {
  return embedded ? showColumnMenu : externalToolbar;
}

function desktopPaneStyle({
  embedded,
  paneMaxHeight,
  desktopInspector,
  entity,
}: {
  embedded: boolean;
  paneMaxHeight: number | null;
  desktopInspector?: ReactNode;
  entity?: Entity;
}): DesktopPaneStyle {
  const style: DesktopPaneStyle = {};
  if (embedded) {
    style.maxHeight = "60vh";
  } else if (paneMaxHeight != null) {
    style.maxHeight = `${paneMaxHeight}px`;
  }
  if (desktopInspector && !embedded && paneMaxHeight != null) {
    style.height = `${paneMaxHeight}px`;
  }
  if (entity && isBrowserRoutedEntity(entity)) {
    style["--row-accent"] = entities[entity].color.accent;
  }
  return style;
}

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

export interface RTableProps<TItem extends RowData> {
  table: ITable<TItem>;
  /** Slot for additional toolbar content like summaries (e.g., "Value: $5,845.91") */
  additionalToolbarContent?: ReactNode;
  /** Primary actions for the toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
  /** Responsive top-level inspector toggle; omitted by embedded/specialist tables. */
  inspectorToggle?: ReactNode;
  isLoading?: boolean;
  error?: unknown;
  ariaLabel?: string;
  timing?: QueryTiming;
  /** Entity type for mobile card navigation - when provided, cards become clickable */
  entity?: Entity;
  /**
   * The entity each row is *about*, when that differs from `entity` — an
   * inventory entry is about its product. Constant per table: only which
   * record varies per row, and the column's `subject` resolver says which.
   * Declaring it here is what publishes that entity's actions to the rows.
   */
  subjectEntity?: Entity;
  /**
   * The entity's resolved actions, published by whichever hook owns the bar's
   * actions so both halves come from one instance. Omit and `RTable` resolves
   * its own — the fallback that keeps a table which wires nothing from having
   * a silently empty row menu.
   */
  rowActions?: EntityActionsEntry;
  actionDialogs?: ReactNode;
  /** Canonical mobile destination for rows whose entity type varies by row. */
  getMobileDetailsHref?: (item: TItem) => string | undefined;
  /** Suppress implicit entity links when cards use a specialist row interaction. */
  disableMobileDetailsHref?: boolean;
  /** Full-width content below a mobile card's compact identity line. */
  renderMobileRowFooter?: (item: TItem) => ReactNode;
  /** Callback when a row is clicked in either the desktop table or mobile card. */
  onRowClick?: (row: Row<TItem>) => void;
  /**
   * Record presently shown in the desktop inspector. This intentionally stays
   * separate from TanStack's row selection, which drives bulk actions.
   */
  currentRowId?: string;
  /** Callback when a row is hovered (desktop) — used to prefetch row data */
  onRowHover?: (row: Row<TItem>) => void;
  /** Cancels an uncommitted row-preview intent. */
  onRowHoverEnd?: (row: Row<TItem>) => void;
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
   * bar), saved views, and page-size controls, which otherwise compete with
   * the section's own tools. Hides the toolbar and pager entirely when they
   * would hold no embedded controls or useful navigation.
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
   * A page workbench owns its query tier outside the bordered table pane.
   * Embedded/detail tables keep compact internal chrome. `none` renders no
   * toolbar at all: the caller's section header owns the create/open-all
   * verbs and the table is a plain scoped grid (detail relation sections).
   */
  toolbarMode?: "auto" | "external" | "internal" | "none";
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
  /**
   * Wide-desktop companion pane for a current record. Page workbenches may use
   * it; embedded relationship ledgers retain their existing standalone shape.
   */
  desktopInspector?: ReactNode;
  /** Server-side facet counts for the table's filter controls. */
  filterOptionHints?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

/** Page state belongs beside the scroll pane, rather than in its wide table. */
function TableStatus<TItem extends RowData>({
  table,
  entity,
  isLoading,
  hydrated,
  error,
  rows,
  emptyState,
  refreshControls,
}: Pick<
  RTableProps<TItem>,
  "table" | "entity" | "isLoading" | "error" | "emptyState" | "refreshControls"
> & {
  hydrated: boolean;
  rows: readonly Row<TItem>[];
}): ReactNode {
  if (isLoading || !hydrated) return <SimpleLoading />;
  if (error) {
    return <ErrorDisplay error={error} onRetry={refreshControls?.onRefresh} />;
  }
  if (rows.length) return null;
  if (emptyState) return emptyState;

  const state = table.state;
  const isFiltered = isNarrowed(table);
  const onClearFilters = hasActiveFilters(state.columnFilters)
    ? () => table.resetColumnFilters()
    : undefined;
  return entity && isBrowserRoutedEntity(entity) ? (
    <EntityEmptyState
      entity={entity}
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
    />
  ) : (
    <FilteredEmptyState
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
    />
  );
}

function DesktopTableToolbar<TItem extends RowData>({
  table,
  entity,
  filterOptionHints,
  inspectorToggle,
  additionalToolbarContent,
  groupConfig,
  grouped,
  onGroupedChange,
  actions,
  bulkActionBar,
  externalToolbar,
  isTransitioning,
  embedded,
  showColumnMenu,
}: Pick<
  RTableProps<TItem>,
  | "table"
  | "entity"
  | "filterOptionHints"
  | "inspectorToggle"
  | "additionalToolbarContent"
  | "groupConfig"
  | "grouped"
  | "onGroupedChange"
  | "actions"
  | "bulkActionBar"
  | "embedded"
  | "showColumnMenu"
> & {
  externalToolbar: boolean;
  isTransitioning: boolean;
}) {
  // `additionalToolbarContent` is a live status readout (a ledger's running
  // total, cell-selection stats) — it stays visible inline in the query tier
  // at both densities, never folded into a menu a caller would have to open
  // to read it. Only the interactive `inspectorToggle`/grouped-list toggle
  // move into the page-mode `Actions ▾` menu; embedded keeps them inline too.
  const groupToggle = embedded ? (
    <GroupToggle
      groupConfig={groupConfig}
      grouped={grouped}
      onGroupedChange={onGroupedChange}
    />
  ) : null;
  const inlineExtras = (
    <div className="flex flex-wrap items-center gap-2">
      {embedded && inspectorToggle}
      {additionalToolbarContent}
      {groupToggle}
    </div>
  );
  const actionsMenuExtra = !embedded && (
    <>
      {inspectorToggle && (
        <div className="flex flex-wrap items-center gap-1 px-1 py-1">
          {inspectorToggle}
        </div>
      )}
      <GroupToggleMenuItem
        groupConfig={groupConfig}
        grouped={grouped}
        onGroupedChange={onGroupedChange}
      />
    </>
  );

  return (
    <DataTableToolbar
      table={table}
      entity={entity}
      filterOptionHints={filterOptionHints}
      additionalContent={inlineExtras}
      actionsMenuExtra={actionsMenuExtra || undefined}
      actions={actions}
      bulkActionBar={bulkActionBar}
      showViewOptions={!embedded || showColumnMenu}
      portalWorkbenchUtilities={externalToolbar}
      workbenchUtilityViewport="desktop"
      isTransitioning={isTransitioning}
      variant={embedded ? "embedded" : "page"}
      className={embedded ? "px-2 py-1" : "px-4 py-1"}
    />
  );
}

function GroupToggle<TItem extends RowData>({
  groupConfig,
  grouped,
  onGroupedChange,
}: Pick<RTableProps<TItem>, "groupConfig" | "grouped" | "onGroupedChange">) {
  if (!groupConfig || !onGroupedChange) return null;
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className="shrink-0"
      onClick={() => onGroupedChange(!grouped)}
      aria-label={grouped ? "Show flat list" : "Show grouped list"}
    >
      {grouped ? (
        <List className="size-4" />
      ) : (
        <LayoutList className="size-4" />
      )}
    </Button>
  );
}

/** The page-mode `Actions ▾` menu's equivalent of {@link GroupToggle}. */
function GroupToggleMenuItem<TItem extends RowData>({
  groupConfig,
  grouped,
  onGroupedChange,
}: Pick<RTableProps<TItem>, "groupConfig" | "grouped" | "onGroupedChange">) {
  if (!groupConfig || !onGroupedChange) return null;
  return (
    <DropdownMenuItem onClick={() => onGroupedChange(!grouped)}>
      <Check className={grouped ? "opacity-100" : "opacity-0"} />
      Grouped
    </DropdownMenuItem>
  );
}

/**
 * Keeps footer geometry in the same coordinate system as the pinned headers.
 * Server totals can render before every infinite row is loaded, so this is
 * deliberately driven by footer definitions, not the loaded-row count.
 */
function PinnedTableFooter<TItem extends RowData>({
  table,
  hasRows,
}: {
  table: ITable<TItem>;
  hasRows: boolean;
}) {
  if (!hasRows) return null;
  const startGroups = table.getStartFooterGroups();
  const centerGroups = table.getCenterFooterGroups();
  const endGroups = table.getEndFooterGroups();
  const footerGroups = Array.from(
    {
      length: Math.max(
        startGroups.length,
        centerGroups.length,
        endGroups.length,
      ),
    },
    (_, index) => ({
      id: `footer-${index}`,
      leading: [
        ...(startGroups[index]?.headers ?? []),
        ...(centerGroups[index]?.headers ?? []),
      ],
      trailing: endGroups[index]?.headers ?? [],
    }),
  );
  if (
    !footerGroups.some((group) =>
      [...group.leading, ...group.trailing].some(
        (header) => header.column.columnDef.footer,
      ),
    )
  )
    return null;
  return (
    <TableFooter className="border-t bg-card text-sm font-medium">
      {footerGroups.map((group) => (
        <TableRow key={group.id} className="hover:bg-muted/50">
          {group.leading.map((header) => (
            <PinnedFooterCell key={header.id} header={header} table={table} />
          ))}
          <TableCell data-spacer aria-hidden />
          {group.trailing.map((header) => (
            <PinnedFooterCell key={header.id} header={header} table={table} />
          ))}
        </TableRow>
      ))}
    </TableFooter>
  );
}

function PinnedFooterCell<TItem extends RowData>({
  header,
  table,
}: {
  header: ReturnType<
    ITable<TItem>["getStartFooterGroups"]
  >[number]["headers"][number];
  table: ITable<TItem>;
}) {
  const pinned = header.column.getIsPinned();
  const width = columnWidthValue(header.column.id);
  const pinnedColumns =
    pinned === "start"
      ? table.getStartVisibleLeafColumns()
      : pinned === "end"
        ? table.getEndVisibleLeafColumns()
        : [];
  const index = pinnedColumns.findIndex(
    (column) => column.id === header.column.id,
  );
  const boundaryClass =
    pinned === "start" && index === pinnedColumns.length - 1
      ? "table-pinned-boundary-start"
      : pinned === "end" && index === 0
        ? "table-pinned-boundary-end"
        : undefined;
  const inset =
    pinned === "start"
      ? { insetInlineStart: header.column.getStart("start") }
      : pinned === "end"
        ? { insetInlineEnd: header.column.getAfter("end") }
        : {};
  return (
    <TableCell
      colSpan={header.colSpan}
      className={cn(
        "px-2 py-1",
        header.column.columnDef.meta?.className,
        pinned && "sticky z-20 bg-card",
        boundaryClass,
      )}
      style={{ width, minWidth: width, maxWidth: width, ...inset }}
    >
      {header.isPlaceholder
        ? null
        : flexRender(header.column.columnDef.footer, header.getContext())}
    </TableCell>
  );
}

type RowSelectionProjection = { focused: boolean; version: string };

/**
 * A row subscribes only to the ranges that cover it. The string version keeps
 * DataRow memoization honest when a column operation changes without moving
 * focus, while avoiding whole-table selection subscriptions during scrolling.
 */
function projectRowSelection<TItem extends RowData>(
  rows: readonly Row<TItem>[],
  rowId: string,
  rowIndex: number,
): (ranges: CellSelectionState) => RowSelectionProjection {
  return (ranges) => ({
    focused: ranges.at(-1)?.focusRowId === rowId,
    version: ranges
      .filter((range) => {
        const anchor = rows.findIndex((row) => row.id === range.anchorRowId);
        const focus = rows.findIndex((row) => row.id === range.focusRowId);
        return (
          anchor >= 0 &&
          focus >= 0 &&
          rowIndex >= Math.min(anchor, focus) &&
          rowIndex <= Math.max(anchor, focus)
        );
      })
      .map(
        (range) =>
          `${range.anchorColumnId}:${range.focusColumnId}:${range.operation ?? "include"}`,
      )
      .join("|"),
  });
}

function VirtualSelectionRow<TItem extends RowData>({
  table,
  rows,
  row,
  rowIndex,
  height,
  currentRowId,
  isDebugEnabled,
  onRowClick,
  onRowHover,
  onRowHoverEnd,
  suppressCellRowClick,
  rowClassName,
  cellClassName,
  columnsKey,
  rowContentVersion,
}: {
  table: ITable<TItem>;
  rows: readonly Row<TItem>[];
  row: Row<TItem>;
  rowIndex: number;
  height: string;
  currentRowId?: string;
  isDebugEnabled: boolean;
  onRowClick?: (row: Row<TItem>) => void;
  onRowHover?: (row: Row<TItem>) => void;
  onRowHoverEnd?: (row: Row<TItem>) => void;
  suppressCellRowClick: boolean;
  rowClassName?: (row: Row<TItem>) => string | undefined;
  cellClassName: string;
  columnsKey: string;
  rowContentVersion: unknown;
}) {
  const selectionProjection = projectRowSelection(rows, row.id, rowIndex);
  const classes = cn(rowClassName?.(row));
  return (
    <table.Subscribe
      source={table.atoms.cellSelection!}
      selector={selectionProjection}
    >
      {(selection) => (
        <table.Subscribe
          source={table.atoms.rowSelection!}
          selector={(selected) => selected[row.id] === true}
        >
          {(isSelected) => (
            <DataRow
              row={row}
              rowIndex={rowIndex}
              isSelected={isSelected}
              isCurrent={currentRowId === row.id}
              isExpanded={row.getIsExpanded()}
              isFocused={selection.focused}
              isDebugEnabled={isDebugEnabled}
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              onRowHoverEnd={onRowHoverEnd}
              suppressCellRowClick={suppressCellRowClick}
              rowClassName={classes}
              cellClassName={cellClassName}
              columnsKey={columnsKey}
              rowContentVersion={rowContentVersion}
              selectionVersion={selection.version}
              height={height}
            />
          )}
        </table.Subscribe>
      )}
    </table.Subscribe>
  );
}

/**
 * Publishes the table's entity actions so its actions column can reach them,
 * and mounts their dialogs.
 *
 * Here rather than at each call site because a surface that forgot the provider
 * got no error — its row menu just silently omitted every declared action, and
 * that is exactly how the product-detail kit tables ended up without
 * "Add to inventory". Every table already tells `RTable` its entity, so no
 * table has to remember anything.
 *
 * Split into its own component and keyed on `entity` by the caller:
 * `useEntityActions` runs one hook per matching definition, so the entity has
 * to be constant for an instance.
 */
function TableWithEntityActions({
  entity,
  children,
}: {
  entity: Entity;
  children: () => ReactNode;
}) {
  const { rowMenuItems, dialogs } = useEntityActions(entity);
  // Read through a ref, the same way `useListBulkActions` publishes its own:
  // `rowMenuItems` is a fresh closure every render (it reads the current
  // handles), so memoizing the value on it would churn the context and
  // re-render every actions cell, while memoizing without it would capture a
  // stale closure and freeze the dialogs a menu item opens.
  const latestRowMenuItems = useRef(rowMenuItems);
  latestRowMenuItems.current = rowMenuItems;
  const rowActions = useMemo<EntityActionsEntry>(
    () => ({
      entity,
      rowMenuItems: (row) => latestRowMenuItems.current(row),
    }),
    [entity],
  );
  return (
    <EntityActionsProvider value={rowActions}>
      {children()}
      {dialogs}
    </EntityActionsProvider>
  );
}

export default function RTable<TItem extends RowData>(
  props: RTableProps<TItem>,
) {
  const { entity, subjectEntity, rowActions, actionDialogs } = props;
  let content = (
    <>
      <RTableInner {...props} />
      {actionDialogs}
    </>
  );
  if (rowActions) {
    const inner = content;
    content = (
      <EntityActionsProvider value={rowActions}>{inner}</EntityActionsProvider>
    );
  }
  // Nested, not merged in one call: each entity needs its own hook instance,
  // and the provider merges what it finds above it.
  if (subjectEntity && subjectEntity !== entity) {
    const inner = content;
    content = (
      <TableWithEntityActions key={subjectEntity} entity={subjectEntity}>
        {() => inner}
      </TableWithEntityActions>
    );
  }
  // Only when nobody published: resolving a second instance for an entity a
  // surface already resolved would give the bar's actions and their dialogs
  // different state.
  if (entity && !rowActions) {
    const inner = content;
    content = (
      <TableWithEntityActions key={entity} entity={entity}>
        {() => inner}
      </TableWithEntityActions>
    );
  }
  return content;
}

function DesktopTableView<TItem extends RowData>({
  table,
  controller,
  entity,
  embedded = false,
  desktopInspector,
  externalToolbar,
  desktopToolbar,
  showToolbar,
  infiniteScroll,
  showPagination,
  showCellSelectionStats,
  timing,
  ariaLabel,
  cellSelectionEnabled,
  statusContent,
  hasStatusContent,
  tableBody,
}: Pick<
  RTableProps<TItem>,
  | "table"
  | "entity"
  | "embedded"
  | "desktopInspector"
  | "infiniteScroll"
  | "showCellSelectionStats"
  | "timing"
  | "ariaLabel"
> & {
  controller: ReturnType<typeof useDataTableController<TItem>>;
  externalToolbar: boolean;
  desktopToolbar: ReactNode;
  showToolbar: boolean;
  showPagination: boolean;
  cellSelectionEnabled: boolean;
  statusContent: ReactNode;
  hasStatusContent: boolean;
  tableBody: ReactNode;
}) {
  const {
    cellSelectionContainerProps,
    columnSizeVars,
    isDebugEnabled,
    isTransitioning,
    isMobile,
    paneWrapperRef,
    paneMaxHeight,
    rows,
    scrollRestorationId,
    styles,
    tableContainerRef,
  } = controller;
  if (isMobile) return null;

  const paneStyle = desktopPaneStyle({
    embedded,
    paneMaxHeight,
    desktopInspector,
    entity,
  });
  const showFooter =
    (!infiniteScroll && showPagination) || showCellSelectionStats;

  return (
    <>
      {externalToolbar && desktopToolbar ? (
        <div className="hidden shrink-0 border-b border-border bg-background md:block">
          {desktopToolbar}
        </div>
      ) : null}
      <CellSelectionContext.Provider value={cellSelectionEnabled}>
        <div
          ref={paneWrapperRef}
          className={cn(
            "relative hidden flex-col md:flex",
            !embedded && "border-r border-b border-[var(--border)]",
            desktopInspector && !embedded && "xl:pr-[25rem]",
          )}
          style={paneStyle}
        >
          {showToolbar && !externalToolbar ? (
            <div className="shrink-0 border-b border-border bg-background">
              {desktopToolbar}
            </div>
          ) : null}
          <section
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The keyboard-navigable grid and horizontal scroll pane must be directly focusable.
            tabIndex={0}
            ref={tableContainerRef}
            data-scroll-restoration-id={scrollRestorationId}
            aria-label={`${ariaLabel} keyboard navigation`}
            className="min-h-0 flex-1 overflow-auto bg-card outline-none data-[cell-dragging]:select-none"
            {...cellSelectionContainerProps}
          >
            <Table
              aria-label={ariaLabel}
              aria-busy={isTransitioning}
              className={cn(styles.table)}
              containerClassName="overflow-visible"
              style={columnSizeVars}
            >
              <TableHeader className="sticky top-0 z-30 bg-card shadow-[0_1px_0_var(--border)] [&_th]:bg-card [&_tr]:border-b-0">
                <TableHeaderLayout
                  table={table}
                  styles={styles}
                  isDebugEnabled={isDebugEnabled}
                />
              </TableHeader>
              <TableBody
                inert={isTransitioning ? true : undefined}
                aria-disabled={isTransitioning || undefined}
              >
                {tableBody}
              </TableBody>
              <PinnedTableFooter table={table} hasRows={rows.length > 0} />
            </Table>
            {hasStatusContent ? (
              <div className="sticky left-0 flex min-h-24 w-full items-center justify-center overflow-hidden px-2 py-4">
                {statusContent}
              </div>
            ) : null}
          </section>
          {showFooter ? (
            <div className="shrink-0 border-t border-[var(--border)] bg-background px-2 py-1">
              <DataTablePagination
                table={table}
                timing={timing}
                showPaginationControls={!infiniteScroll && showPagination}
                showCellSelectionStats={showCellSelectionStats}
                variant={tableChromeVariant(embedded)}
              />
            </div>
          ) : null}
          {desktopInspector && !embedded ? (
            <div
              className="absolute inset-y-0 right-0 hidden w-[25rem] overflow-y-auto border-l border-border bg-card xl:block"
              data-desktop-inspector
            >
              {desktopInspector}
            </div>
          ) : null}
        </div>
      </CellSelectionContext.Provider>
    </>
  );
}

function tableChrome<TItem extends RowData>({
  table,
  embedded,
  showColumnMenu,
  actions,
  bulkActionBar,
  additionalToolbarContent,
  groupConfig,
  inspectorToggle,
  toolbarMode,
  hasPageIdentity,
  hasWorkbenchTarget,
}: Pick<
  RTableProps<TItem>,
  | "table"
  | "embedded"
  | "showColumnMenu"
  | "actions"
  | "bulkActionBar"
  | "additionalToolbarContent"
  | "groupConfig"
  | "inspectorToggle"
  | "toolbarMode"
> & {
  hasPageIdentity: boolean;
  hasWorkbenchTarget: boolean;
}) {
  const hasFilterConfig = table
    .getAllLeafColumns()
    .some((column) => column.columnDef.meta?.filterConfig);
  const hasToolbarContent = Boolean(
    actions ??
    bulkActionBar ??
    additionalToolbarContent ??
    groupConfig ??
    hasFilterConfig,
  );
  return {
    showToolbar:
      toolbarMode !== "none" &&
      (!embedded || showColumnMenu || hasToolbarContent),
    showPagination: !embedded || table.getPageCount() > 1,
    topLevelInspectorToggle: embedded ? null : inspectorToggle,
    externalToolbar:
      !embedded &&
      (toolbarMode === "external" ||
        (toolbarMode === "auto" && (hasPageIdentity || hasWorkbenchTarget))),
  };
}

function RTableInner<TItem extends RowData>(props: RTableProps<TItem>) {
  const {
    table,
    additionalToolbarContent,
    actions,
    inspectorToggle,
    bulkActionBar,
    isLoading = false,
    error,
    ariaLabel = "Data Table",
    timing,
    entity,
    getMobileDetailsHref,
    disableMobileDetailsHref,
    renderMobileRowFooter,
    onRowClick,
    currentRowId,
    onRowHover,
    onRowHoverEnd,
    infiniteScroll,
    refreshControls,
    groupConfig,
    grouped = false,
    onGroupedChange,
    getRowClassName,
    verticalAlign = "middle",
    embedded = false,
    showColumnMenu = false,
    toolbarMode = "auto",
    emptyState,
    showCellSelectionStats = false,
    desktopInspector,
    filterOptionHints,
  } = props;
  const controller = useDataTableController({
    table,
    infiniteScroll,
    groupConfig,
    grouped,
    verticalAlign,
    onRowClick,
  });
  const pageIdentity = usePageIdentity();
  const workbenchTarget = usePageWorkbenchTarget();
  const {
    colSpan,
    columnsKey,
    dConfig,
    hydrated,
    isDebugEnabled,
    isFetchingNextPage,
    isTransitioning,
    isMobile,
    resolveIndex,
    rows,
    rowContentVersion,
    setDesktopInfiniteSentinel,
    styles,
    totalSize,
    virtualRows,
  } = controller;

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
  const {
    showToolbar,
    showPagination,
    topLevelInspectorToggle,
    externalToolbar,
  } = tableChrome({
    table,
    embedded,
    showColumnMenu,
    actions,
    bulkActionBar,
    additionalToolbarContent,
    groupConfig,
    inspectorToggle,
    toolbarMode,
    hasPageIdentity: pageIdentity !== null,
    hasWorkbenchTarget: workbenchTarget !== null,
  });

  // This deliberately stays outside a full-width table cell: page status is
  // bounded by the scroll pane, not by the table's total scroll width.
  const statusContent = (
    <TableStatus
      table={table}
      entity={entity}
      isLoading={isLoading}
      hydrated={hydrated}
      error={error}
      rows={rows}
      emptyState={emptyState}
      refreshControls={refreshControls}
    />
  );
  const hasStatusContent =
    isLoading || !hydrated || Boolean(error) || rows.length === 0;
  const entityMediaRefs = collectTableEntityMediaRefs(
    table.getVisibleLeafColumns(),
    rows,
  );

  const desktopToolbar = showToolbar ? (
    <DesktopTableToolbar
      table={table}
      entity={entity}
      filterOptionHints={filterOptionHints}
      inspectorToggle={topLevelInspectorToggle}
      additionalToolbarContent={additionalToolbarContent}
      groupConfig={groupConfig}
      grouped={grouped}
      onGroupedChange={onGroupedChange}
      actions={actions}
      bulkActionBar={bulkActionBar}
      externalToolbar={externalToolbar}
      isTransitioning={isTransitioning}
      embedded={embedded}
      showColumnMenu={showColumnMenu}
    />
  ) : null;

  const renderTableBody = () => {
    // Keep loaded rows usable after a failed refresh; status lives below the table.
    if (!hydrated || (isLoading && rows.length === 0)) return null;

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
              aria-label="Virtualized rows above"
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
                className="border-b border-border bg-background"
                style={{ height: `${virtualRow.size}px` }}
              >
                <TableCell
                  colSpan={colSpan}
                  className="text-center text-xs text-muted-foreground"
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
                key={`group-${item.key ?? item.title}`}
                className="border-b border-border/30"
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
            <VirtualSelectionRow
              key={row.id}
              table={table}
              rows={rows}
              row={row}
              rowIndex={item.rowIndex}
              height={`${virtualRow.size}px`}
              currentRowId={currentRowId}
              isDebugEnabled={isDebugEnabled}
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              onRowHoverEnd={onRowHoverEnd}
              suppressCellRowClick={cellSelectionEnabled}
              rowClassName={(candidate) =>
                cn(styles.row, getRowClassName?.(candidate))
              }
              cellClassName={styles.cell}
              columnsKey={columnsKey}
              rowContentVersion={rowContentVersion}
            />
          );
        })}

        {/* Bottom padding row for remaining scroll space */}
        {bottomSpacerHeight > 0 && (
          <tr>
            <td
              aria-label="Virtualized rows below"
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
    <RecordSuggestionsProvider
      entity={entity}
      records={
        isLoading || isTransitioning ? [] : rows.map((row) => row.original)
      }
      fieldKeys={table.getVisibleLeafColumns().map((column) => column.id)}
    >
      <EntityDisplayImagesProvider refs={entityMediaRefs}>
        <Stack>
          <DesktopTableView
            table={table}
            controller={controller}
            entity={entity}
            embedded={embedded}
            desktopInspector={desktopInspector}
            externalToolbar={externalToolbar}
            desktopToolbar={desktopToolbar}
            showToolbar={showToolbar}
            infiniteScroll={infiniteScroll}
            showPagination={showPagination}
            showCellSelectionStats={showCellSelectionStats}
            timing={timing}
            ariaLabel={ariaLabel}
            cellSelectionEnabled={cellSelectionEnabled}
            statusContent={statusContent}
            hasStatusContent={hasStatusContent}
            tableBody={renderTableBody()}
          />

          {/* Mobile List View. Also rendered pre-hydration (see the desktop
          wrapper's breakpoint comment) so a phone's first paint is the
          shape-matched skeleton rather than a clipped desktop table. */}
          {(isMobile || !hydrated) && (
            <MobileListScreen
              table={table}
              entity={entity}
              getDetailsHref={getMobileDetailsHref}
              disableDetailsHref={disableMobileDetailsHref}
              renderRowFooter={renderMobileRowFooter}
              onRowClick={onRowClick}
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
              portalWorkbenchUtilities={externalToolbar}
              showToolbar={showToolbar}
              showViewOptions={showMobileViewOptions({
                embedded,
                showColumnMenu,
                externalToolbar,
              })}
              toolbarVariant={tableChromeVariant(embedded)}
              emptyState={emptyState}
            />
          )}

          {/* Mobile keeps the inline pager, hidden when infinite scroll is active */}
          {isMobile && table.getPageCount() > 1 && !infiniteScroll && (
            <DataTablePagination
              table={table}
              timing={timing}
              variant={tableChromeVariant(embedded)}
            />
          )}
        </Stack>
      </EntityDisplayImagesProvider>
    </RecordSuggestionsProvider>
  );
}
