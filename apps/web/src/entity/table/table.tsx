import type { Entity } from "@cubby/schemas/entity";

import "../../ui/data-table/table.css";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { ListDashesIcon } from "@phosphor-icons/react/dist/csr/ListDashes";
import type { CellSelectionState, RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { usePageIdentity, usePageWorkbenchTarget } from "~/entity/page/page";
import { ProposalCountProvider } from "~/entity/suggestions/proposal-counts";
import {
  RecordSuggestionsBulkAction,
  RecordSuggestionsProvider,
  RecordSuggestionBoundary,
} from "~/entity/suggestions/record-suggestions";
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";
import { CurrencyValue } from "~/ui/common/currency-value";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QueryRefreshStatus } from "~/ui/feedback/query-refresh-status";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "~/ui/primitives/dropdown-menu";
import { Skeleton } from "~/ui/primitives/skeleton";
import {
  StaticTable,
  type StaticTableColumn,
} from "~/ui/primitives/static-table";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

import type { BulkActionPreview } from "../../ui/data-table/bulk-actions.types";
import { tableMoneyTotals } from "../../ui/data-table/bulk/table-money";
import { CellSelectionContext } from "../../ui/data-table/cell-selection-context";
import {
  columnOffsetValue,
  columnWidthValue,
  spacerWidthValue,
} from "../../ui/data-table/column-layout";
import { DataTablePagination } from "../../ui/data-table/data-table-pagination";
import {
  createRowActivityStore,
  RowActivityStoreContext,
} from "../../ui/data-table/row-activity";
import { SectionHeader } from "../../ui/data-table/section-header";
import { collectTableEntityMediaRefs } from "../../ui/data-table/table-entity-media";
import type {
  CubbyTable as ITable,
  CubbyRow as Row,
} from "../../ui/data-table/table-features";
import { isUnpaged } from "../../ui/data-table/table-features";
import { TreeStatusRow } from "../../ui/data-table/tree-status-row";
import { useDataTableController } from "../../ui/data-table/use-data-table-controller";
import type { GroupConfig } from "../../ui/data-table/use-grouped-list";
import { serverTreeStatusOf } from "../../ui/hooks/use-server-tree-children";
import {
  SidePanelLayout,
  TableRowStepContext,
} from "../../ui/overlays/side-panel";
import {
  type EntityActionsEntry,
  EntityActionsProvider,
  useEntityActions,
} from "../actions/entity-actions";
import { EntityDisplayImagesProvider } from "../entity-media/entity-display-images";
import type { InfiniteScrollControls } from "../hooks/use-infinite-table-list";
import { DataTableToolbar } from "./data-table-toolbar";
import { DesktopDataRow as DataRow } from "./desktop-data-row";
import { TableEmptyState } from "./entity-empty-states";
import { HeaderFilterEditor } from "./ledger-filters";
import { MobileListScreen } from "./mobile-list-screen";
import TableHeaderLayout from "./table-header-layout";

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
  /** Print every filtered/sorted loaded row through StaticTable, without virtual gaps. */
  printable?: boolean;
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
  /**
   * Why these rows show no image column. Only rows that are not records take
   * one (usage tallies, aggregates, nutrients); a table of records adds
   * `createImageColumn`, with `imageRef` when its rows are about a record.
   */
  withoutImages?: string;
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
  /**
   * The list's bulk verbs, listed disabled in the page-mode `Actions ▾` menu
   * while nothing is selected, so they are discoverable at rest.
   */
  bulkActionPreview?: readonly BulkActionPreview[];
  /** Infinite scroll controls — when provided, mobile hides pagination and auto-loads more */
  infiniteScroll?: InfiniteScrollControls;
  /** Pull-to-refresh controls for mobile list rendering */
  refreshControls?: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
  /** The active Group by choice and its server sections (mobile + desktop). */
  groupConfig?: GroupConfig;
  /**
   * Full-width content beneath each row in `openIds` (desktop), measured
   * rather than held to the row height: inline evidence a person compares
   * across several open rows.
   */
  rowDetail?: {
    openIds: ReadonlySet<string>;
    render: (row: Row<TItem>) => ReactNode;
  };
  /** A server tree's nested/flat switch. */
  nestToggle?: NestToggle;
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
  /** Table-owned row inspector, docked at xl and presented in a sheet below. */
  inspector?: {
    content: ReactNode;
    title: string;
    onClose: () => void;
  };
}

function TableInspectorLayout({
  inspector,
  children,
}: {
  inspector?: RTableProps<object>["inspector"];
  children: ReactNode;
}) {
  if (!inspector) return children;
  return (
    <SidePanelLayout
      panel={inspector.content}
      title={inspector.title}
      onClose={inspector.onClose}
    >
      {children}
    </SidePanelLayout>
  );
}

function TablePrintView<TItem extends RowData>({
  table,
  ariaLabel,
  rowDetail,
}: Pick<RTableProps<TItem>, "table" | "ariaLabel" | "rowDetail">) {
  const columns = table.getVisibleLeafColumns();
  // This is the complete loaded row model, not a promise to fetch server pages.
  const rows = table
    .getPrePaginatedRowModel()
    .rows.flatMap((row) => [
      { row, detail: false },
      ...(rowDetail?.openIds.has(row.id) ? [{ row, detail: true }] : []),
    ]);
  return (
    <StaticTable
      aria-label={ariaLabel}
      containerClassName="hidden print:block print:overflow-visible"
      className="table-auto"
      rows={rows}
      rowKey={({ row, detail }) => `${row.id}:${detail ? "detail" : "record"}`}
      columns={columns.map<StaticTableColumn<(typeof rows)[number]>>(
        (column, index) => ({
          id: column.id,
          header:
            typeof column.columnDef.header === "string"
              ? column.columnDef.header
              : column.id,
          cellProps: ({ detail }) =>
            detail ? (index === 0 ? { colSpan: columns.length } : null) : {},
          cell: ({ row, detail }) => {
            if (detail) return rowDetail?.render(row);
            const cell = row
              .getVisibleCells()
              .find((cell) => cell.column.id === column.id);
            return cell
              ? flexRender(column.columnDef.cell, cell.getContext())
              : null;
          },
        }),
      )}
    />
  );
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
  if (isLoading || !hydrated) return null;
  if (error) {
    return rows.length > 0 ? (
      <QueryRefreshStatus error={error} onRetry={refreshControls?.onRefresh} />
    ) : (
      <ErrorDisplay error={error} onRetry={refreshControls?.onRefresh} />
    );
  }
  if (rows.length) return null;
  if (emptyState) return emptyState;

  return <TableEmptyState entity={entity} table={table} />;
}

function DesktopTableToolbar<TItem extends RowData>({
  table,
  entity,
  filterOptionHints,
  inspectorToggle,
  additionalToolbarContent,
  nestToggle,
  actions,
  bulkActionBar,
  bulkActionPreview,
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
  | "nestToggle"
  | "actions"
  | "bulkActionBar"
  | "bulkActionPreview"
  | "embedded"
  | "showColumnMenu"
> & {
  externalToolbar: boolean;
  isTransitioning: boolean;
}) {
  // `additionalToolbarContent` is a live status readout (a ledger's running
  // total, cell-selection stats) — it stays visible inline in the query tier
  // at both densities, never folded into a menu a caller would have to open
  // to read it. Only the interactive `inspectorToggle`/nested-list toggle
  // move into the page-mode `Actions ▾` menu; embedded keeps them inline too.
  const switches = presentationSwitches(nestToggle);
  const groupToggle = embedded
    ? switches.map((toggle) => (
        <PresentationToggle key={toggle.id} toggle={toggle} />
      ))
    : null;
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
      {switches.map((toggle) => (
        <PresentationToggleMenuItem key={toggle.id} toggle={toggle} />
      ))}
      {bulkActionPreview && bulkActionPreview.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Select rows to</DropdownMenuLabel>
          {bulkActionPreview.map((action) => (
            <DropdownMenuItem key={action.id} disabled>
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      )}
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

/** A server tree's nested/flat switch (`list.tree.toggle`). */
export interface NestToggle {
  nested: boolean;
  onNestedChange: (nested: boolean) => void;
}

/** A list presentation that is either on (nested) or flat. */
interface PresentationSwitch {
  id: "nested";
  /** The Actions-menu label. */
  label: string;
  /** The inline button's label while flat. */
  showLabel: string;
  active: boolean;
  onChange: (active: boolean) => void;
}

function presentationSwitches(
  nestToggle: NestToggle | undefined,
): PresentationSwitch[] {
  return nestToggle
    ? [
        {
          id: "nested",
          label: "Nested",
          showLabel: "Show nested list",
          active: nestToggle.nested,
          onChange: nestToggle.onNestedChange,
        },
      ]
    : [];
}

function PresentationToggle({ toggle }: { toggle: PresentationSwitch }) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className="shrink-0"
      onClick={() => toggle.onChange(!toggle.active)}
      aria-label={toggle.active ? "Show flat list" : toggle.showLabel}
    >
      {toggle.active ? (
        <ListIcon className="size-4" />
      ) : (
        <ListDashesIcon className="size-4" />
      )}
    </Button>
  );
}

/** The page-mode `Actions ▾` menu's equivalent of {@link PresentationToggle}. */
function PresentationToggleMenuItem({
  toggle,
}: {
  toggle: PresentationSwitch;
}) {
  return (
    <DropdownMenuItem
      onClick={() => toggle.onChange(!toggle.active)}
      aria-label={toggle.active ? "Show flat list" : toggle.showLabel}
    >
      <CheckIcon className={toggle.active ? "opacity-100" : "opacity-0"} />
      {toggle.label}
    </DropdownMenuItem>
  );
}

/**
 * Keeps footer geometry in the same coordinate system as the pinned headers.
 * A loaded currency projection admits the footer. Existing server aggregates
 * retain their full-set totals; other money columns sum the loaded rows.
 */
function PinnedTableFooter<TItem extends RowData>({
  table,
  hasRows,
}: {
  table: ITable<TItem>;
  hasRows: boolean;
}) {
  if (
    !hasRows ||
    tableMoneyTotals(
      table.getVisibleLeafColumns(),
      table.getFilteredRowModel().rows,
    ).length === 0
  )
    return null;
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
  return (
    <TableFooter className="border-t border-hairline-strong bg-card text-sm font-semibold">
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
      ? {
          insetInlineStart: columnOffsetValue(
            pinnedColumns,
            header.column.id,
            "start",
          ),
        }
      : pinned === "end"
        ? {
            insetInlineEnd: columnOffsetValue(
              pinnedColumns,
              header.column.id,
              "end",
            ),
          }
        : {};
  const loaded = table.getFilteredRowModel().rows;
  const money = tableMoneyTotals([header.column], loaded)[0];
  const serverTotal =
    table.options.meta?.serverTotals?.sums?.[header.column.id];
  const total = serverTotal ?? money?.value;
  const identity =
    header.column.columnDef.meta?.entityColumnRole === "identity";
  const fullTotal = tableMoneyTotals(
    table.getVisibleLeafColumns(),
    loaded,
  ).some(
    (column) =>
      table.options.meta?.serverTotals?.sums?.[column.columnId] !== undefined,
  );
  const count = fullTotal
    ? (table.options.meta?.serverTotals?.totalCount ?? loaded.length)
    : loaded.length;
  const footer =
    money && total !== undefined ? (
      <CurrencyValue value={total} interactive={false} />
    ) : identity ? (
      <span className="font-normal text-muted-foreground">
        {count} {fullTotal ? "rows" : "loaded rows"}
      </span>
    ) : (
      flexRender(header.column.columnDef.footer, header.getContext())
    );
  return (
    <TableCell
      data-column-id={header.column.id}
      colSpan={header.colSpan}
      className={cn(
        "h-8 border-t border-hairline-strong px-1 py-0",
        header.column.columnDef.meta?.className,
        pinned && "sticky z-20 bg-card",
        boundaryClass,
      )}
      style={{ width, minWidth: width, maxWidth: width, ...inset }}
    >
      {header.isPlaceholder ? null : footer}
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
    <RecordSuggestionBoundary record={row.original}>
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
    </RecordSuggestionBoundary>
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
  const table = props.table;
  const filterWarnings = useRef(new Set<string>());
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Inspect a bounded loaded sample only when data or choice declarations change.
    const rows = table.getCoreRowModel().flatRows.slice(0, 100);
    for (const column of table.getAllLeafColumns()) {
      const config = column.columnDef.meta?.filterConfig;
      if (
        config?.filterType !== "multiselect" ||
        config.options === undefined ||
        config.onActivate ||
        config.onSearchChange ||
        config.records ||
        config.referenceEntity ||
        config.isLoading ||
        config.freeText ||
        !column.accessorFn ||
        filterWarnings.current.has(column.id)
      )
        continue;
      const choices = new Set(
        config.options.flatMap(({ value, label }) => [value, label]),
      );
      const missing = rows.some((row) => {
        const value = row.getValue(column.id);
        return (Array.isArray(value) ? value : [value]).some(
          (item) =>
            typeof item === "string" && item !== "" && !choices.has(item),
        );
      });
      if (missing) {
        filterWarnings.current.add(column.id);
        console.warn(
          `RTable column ${column.id} displays a value absent from its multiselect choices.`,
        );
      }
    }
  }, [table, table.options.data, table.options.columns]);
  if (
    import.meta.env.DEV &&
    props.withoutImages === undefined &&
    !props.table
      .getAllLeafColumns()
      .some((column) => column.columnDef.meta?.entityColumnRole === "image")
  )
    throw new Error(
      `${props.ariaLabel ?? entity ?? "This table"} has no image column: add createImageColumn, or pass withoutImages with why its rows are not records.`,
    );
  let content = (
    <>
      {props.printable ? (
        <>
          <div className="print:hidden">
            <RTableInner {...props} />
          </div>
          <TablePrintView
            table={props.table}
            ariaLabel={props.ariaLabel}
            rowDetail={props.rowDetail}
          />
        </>
      ) : (
        <RTableInner {...props} />
      )}
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
  isLoading,
  controller,
  entity,
  embedded = false,
  desktopInspector,
  rowInspectorOpen,
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
  | "isLoading"
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
  rowInspectorOpen: boolean;
}) {
  const {
    cellSelectionContainerProps,
    collapsedColumns,
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
        <div className="hidden shrink-0 border-b border-border bg-background md:block [&:empty]:hidden">
          {desktopToolbar}
        </div>
      ) : null}
      <CellSelectionContext.Provider value={cellSelectionEnabled}>
        <div
          ref={paneWrapperRef}
          className={cn(
            "relative hidden flex-col md:flex",
            !embedded && "border-r border-b border-[var(--border)]",
            desktopInspector && !embedded && "xl:pr-(--side-panel-width)",
          )}
          style={paneStyle}
        >
          {showToolbar && !externalToolbar ? (
            <div className="shrink-0 border-b border-border bg-background">
              {desktopToolbar}
            </div>
          ) : null}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- This labeled, focusable scroll region owns grid keyboard navigation. */}
          <section
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The keyboard-navigable grid and horizontal scroll pane must be directly focusable.
            tabIndex={0}
            ref={tableContainerRef}
            data-scroll-restoration-id={scrollRestorationId}
            aria-label={`${ariaLabel} keyboard navigation`}
            className="min-h-0 flex-1 overflow-auto bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[cell-dragging]:select-none"
            {...cellSelectionContainerProps}
            onKeyDown={(event) => {
              // An open inspector owns Escape; resetting a selected grid cell
              // here would prevent the shared panel's close handler from seeing it.
              if (rowInspectorOpen && event.key === "Escape") return;
              cellSelectionContainerProps.onKeyDown?.(event);
            }}
          >
            <Table
              aria-label={ariaLabel}
              aria-busy={isTransitioning || isLoading}
              className={styles.table}
              containerClassName="overflow-visible"
              style={columnSizeVars}
            >
              {/* A spanning first header row otherwise makes fixed-table layout
                  divide each band's width equally among its leaf columns. */}
              {table
                .getVisibleLeafColumns()
                .some((column) => column.columnDef.meta?.columnGroup) && (
                <colgroup>
                  {[
                    ...table.getStartVisibleLeafColumns(),
                    ...table.getCenterVisibleLeafColumns(),
                  ].map((column) => (
                    <col
                      key={column.id}
                      style={{ width: columnWidthValue(column.id) }}
                    />
                  ))}
                  <col style={{ width: spacerWidthValue }} />
                  {table.getEndVisibleLeafColumns().map((column) => (
                    <col
                      key={column.id}
                      style={{ width: columnWidthValue(column.id) }}
                    />
                  ))}
                  {isDebugEnabled && <col />}
                </colgroup>
              )}
              <TableHeader className="sticky top-0 z-30 border-b border-border bg-card [&_th]:bg-card [&_tr]:border-b-0">
                <TableHeaderLayout
                  table={table}
                  collapsedColumns={collapsedColumns}
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
              className="absolute inset-y-0 right-0 hidden w-(--side-panel-width) overflow-y-auto border-l border-border bg-card xl:block"
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
  | "inspectorToggle"
  | "toolbarMode"
> & {
  hasPageIdentity: boolean;
  hasWorkbenchTarget: boolean;
}) {
  const hasFilterConfig = Boolean(
    table.options.meta?.primarySearch ||
    table.options.meta?.filterFields?.length ||
    table
      .getAllLeafColumns()
      .some((column) => column.columnDef.meta?.filterConfig),
  );
  const hasToolbarContent = Boolean(
    actions ?? bulkActionBar ?? additionalToolbarContent ?? hasFilterConfig,
  );
  return {
    showToolbar:
      toolbarMode !== "none" &&
      (!embedded || showColumnMenu || hasToolbarContent),
    showPagination:
      (!embedded && !isUnpaged(table.state.pagination.pageSize)) ||
      table.getPageCount() > 1,
    topLevelInspectorToggle: embedded ? null : inspectorToggle,
    externalToolbar:
      !embedded &&
      (toolbarMode === "external" ||
        (toolbarMode === "auto" && (hasPageIdentity || hasWorkbenchTarget))),
  };
}

function withSuggestionsBulkAction<TItem extends RowData>(
  bulkActionBar: ReactNode,
  records: readonly TItem[],
) {
  return (
    <>
      {bulkActionBar}
      <RecordSuggestionsBulkAction records={records} />
    </>
  );
}

function RTableInner<TItem extends RowData>(props: RTableProps<TItem>) {
  const {
    table,
    additionalToolbarContent,
    actions,
    inspectorToggle,
    bulkActionBar,
    bulkActionPreview,
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
    rowDetail,
    nestToggle,
    getRowClassName,
    verticalAlign = "middle",
    embedded = false,
    showColumnMenu = false,
    toolbarMode = "auto",
    emptyState,
    showCellSelectionStats = false,
    desktopInspector,
    inspector,
    filterOptionHints,
  } = props;
  const controller = useDataTableController({
    table,
    infiniteScroll,
    groupConfig,
    detailRowIds: rowDetail?.openIds,
    verticalAlign,
    onRowClick,
  });
  const pageIdentity = usePageIdentity();
  const workbenchTarget = usePageWorkbenchTarget();
  const statusTarget = usePageWorkbenchTarget("status", !embedded);
  const {
    colSpan,
    columnsKey,
    dConfig,
    hydrated,
    isDebugEnabled,
    isFetchingNextPage,
    isTransitioning,
    isMobile,
    measureElement,
    resolveIndex,
    rows,
    rowContentVersion,
    stickyIndex,
    styles,
    tableContainerRef,
    tableContainerWidth,
    totalSize,
    virtualRows,
    scrollToFlatRow,
  } = controller;
  const stepRow = useCallback(
    (direction: -1 | 1) => {
      const index = rows.findIndex((row) => row.id === currentRowId);
      const next = index < 0 ? undefined : rows[index + direction];
      if (!next || !onRowClick) return false;
      scrollToFlatRow(index + direction);
      onRowClick(next);
      return true;
    },
    [rows, currentRowId, onRowClick, scrollToFlatRow],
  );
  const columnHeadHeight = useColumnHeadHeight(
    tableContainerRef,
    groupConfig !== undefined && !isMobile,
  );

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
  const selectedRecords = table
    .getSelectedRowModel()
    .rows.map((row) => row.original);
  const bulkActionsWithSuggestions = withSuggestionsBulkAction(
    bulkActionBar,
    selectedRecords,
  );

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
    bulkActionBar: bulkActionsWithSuggestions,
    additionalToolbarContent,
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
    !isLoading && hydrated && (Boolean(error) || rows.length === 0);
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
      nestToggle={nestToggle}
      actions={actions}
      bulkActionBar={bulkActionsWithSuggestions}
      bulkActionPreview={bulkActionPreview}
      externalToolbar={externalToolbar}
      isTransitioning={isTransitioning}
      embedded={embedded}
      showColumnMenu={showColumnMenu}
    />
  ) : null;

  // One active row per table; see row-activity.
  const [rowActivity] = useState(createRowActivityStore);
  const renderTableBody = () => {
    // Keep loaded rows usable after a failed refresh; status lives below the table.
    if (!hydrated || (isLoading && rows.length === 0))
      return (
        <>
          {Array.from({ length: 10 }, (_, index) => (
            <TableRow
              key={`skeleton-${index}`}
              aria-hidden
              className="h-8 hover:bg-transparent"
            >
              {table.getVisibleLeafColumns().map((column) => (
                <TableCell
                  key={column.id}
                  className="h-8 border-b border-hairline-soft px-1 py-0"
                  style={{
                    width: columnWidthValue(column.id),
                    maxWidth: columnWidthValue(column.id),
                  }}
                >
                  <Skeleton
                    className={
                      column.columnDef.meta?.entityColumnRole === "selection"
                        ? "size-3.5"
                        : "h-3 w-2/3 max-w-32"
                    }
                  />
                </TableCell>
              ))}
              <TableCell data-spacer />
            </TableRow>
          ))}
        </>
      );

    // A pinned section header scrolled out of range renders ahead of the top
    // spacer, which gives up the header's height so the layout keeps its size.
    const [first, second] = virtualRows;
    const detachedSticky =
      first !== undefined &&
      first.index === stickyIndex &&
      second !== undefined &&
      second.start > first.end;
    const topSpacerHeight = detachedSticky
      ? second.start - first.size
      : (first?.start ?? 0);
    const leadingRows = detachedSticky ? [first] : [];
    const rangeRows = detachedSticky ? virtualRows.slice(1) : virtualRows;
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

    const renderVirtualRow = (virtualRow: VirtualItem) => {
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
              {isFetchingNextPage ? "Loading more..." : null}
            </TableCell>
          </TableRow>
        );
      }
      if (item.kind === "header") {
        return (
          <TableRow
            key={`group-${item.key}`}
            className="border-b-0 hover:bg-transparent"
            style={{ height: `${virtualRow.size}px` }}
          >
            <TableCell
              colSpan={colSpan}
              className="sticky z-[25] p-0"
              style={{ top: `${columnHeadHeight}px` }}
            >
              <SectionHeader
                title={item.title}
                count={item.count}
                depth={item.depth}
                collapsed={item.collapsed}
                onToggle={item.onToggle}
                onFilter={item.onFilter}
                onHide={item.onHide}
                aside={item.aside}
                actions={item.actions}
              />
            </TableCell>
          </TableRow>
        );
      }
      if (item.kind === "detail") {
        const detailRow = rows[item.rowIndex]!;
        return (
          <TableRow
            key={`detail-${item.occurrenceKey ?? detailRow.id}`}
            ref={measureElement}
            data-index={virtualRow.index}
            className="border-b border-border bg-muted/40 hover:bg-muted/40"
          >
            <TableCell colSpan={colSpan} className="p-0">
              {/* Pinned to the pane's left edge so a wide table's detail
                  stays readable without scrolling sideways. */}
              <div
                className="sticky left-0"
                style={
                  tableContainerWidth
                    ? { width: `${tableContainerWidth}px` }
                    : undefined
                }
              >
                {rowDetail?.render(detailRow)}
              </div>
            </TableCell>
          </TableRow>
        );
      }
      // Grouped or not, a row item's `rowIndex` indexes `rows`.
      const row = rows[item.rowIndex]!;
      const treeStatus = serverTreeStatusOf(row.original);
      if (treeStatus)
        return (
          <TableRow
            key={item.occurrenceKey ?? row.id}
            className="border-b border-border"
            style={{ height: `${virtualRow.size}px` }}
          >
            <TableCell
              colSpan={colSpan}
              className="py-0"
              style={{ paddingLeft: `${row.depth * 1.25 + 0.5}rem` }}
            >
              <TreeStatusRow status={treeStatus} />
            </TableCell>
          </TableRow>
        );
      return (
        <VirtualSelectionRow
          key={item.occurrenceKey ?? row.id}
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
    };

    return (
      <RowActivityStoreContext value={rowActivity}>
        {leadingRows.map(renderVirtualRow)}
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
        {rangeRows.map(renderVirtualRow)}

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
      </RowActivityStoreContext>
    );
  };

  return (
    <ProposalCountProvider
      entity={entity}
      records={
        isLoading || isTransitioning ? [] : rows.map((row) => row.original)
      }
    >
      <RecordSuggestionsProvider
        viewportOnly
        statusTarget={statusTarget}
        entity={entity}
        records={
          isLoading || isTransitioning ? [] : rows.map((row) => row.original)
        }
        fieldKeys={table.getVisibleLeafColumns().map((column) => column.id)}
      >
        <EntityDisplayImagesProvider refs={entityMediaRefs}>
          <TableInspectorLayout
            inspector={
              inspector
                ? {
                    ...inspector,
                    content: inspector.content ? (
                      <TableRowStepContext.Provider value={stepRow}>
                        {inspector.content}
                      </TableRowStepContext.Provider>
                    ) : null,
                  }
                : undefined
            }
          >
            <Stack>
              {/* Without a toolbar, header Filter… opens beside the header. */}
              {showToolbar ? null : (
                <HeaderFilterEditor
                  table={table}
                  entity={entity}
                  optionHints={filterOptionHints}
                />
              )}
              <DesktopTableView
                table={table}
                isLoading={isLoading || !hydrated}
                controller={controller}
                entity={entity}
                embedded={embedded}
                rowInspectorOpen={Boolean(
                  inspector?.content || desktopInspector,
                )}
                desktopInspector={
                  desktopInspector ? (
                    <TableRowStepContext.Provider value={stepRow}>
                      {desktopInspector}
                    </TableRowStepContext.Provider>
                  ) : undefined
                }
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
                  bulkActionBar={bulkActionsWithSuggestions}
                  isLoading={isLoading}
                  error={error}
                  infiniteScroll={infiniteScroll}
                  refreshControls={refreshControls}
                  groupConfig={groupConfig}
                  presentationSwitches={presentationSwitches(nestToggle)}
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
          </TableInspectorLayout>
        </EntityDisplayImagesProvider>
      </RecordSuggestionsProvider>
    </ProposalCountProvider>
  );
}

/**
 * The pinned column header's height, which a sticky section header sits
 * beneath. Measured because a column header can wrap or carry filters.
 */
function useColumnHeadHeight(
  paneRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const head = enabled ? paneRef.current?.querySelector("thead") : null;
    if (!head || !globalThis.ResizeObserver) return;
    const measure = () => setHeight(head.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    return () => observer.disconnect();
  }, [enabled, paneRef]);
  return height;
}
