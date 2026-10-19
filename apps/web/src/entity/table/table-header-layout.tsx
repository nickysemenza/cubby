import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { humanize } from "@cubby/shared";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowsDownUpIcon } from "@phosphor-icons/react/dist/csr/ArrowsDownUp";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { HashIcon } from "@phosphor-icons/react/dist/csr/Hash";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { SortAscendingIcon } from "@phosphor-icons/react/dist/csr/SortAscending";
import { SortDescendingIcon } from "@phosphor-icons/react/dist/csr/SortDescending";
import { ToggleLeftIcon } from "@phosphor-icons/react/dist/csr/ToggleLeft";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Header, RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { EntityIcon } from "~/entity/entities";
import { FieldProvenance } from "~/entity/fields/field-provenance";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { TableHead, TableRow } from "~/ui/primitives/table";

import {
  columnWidthValue,
  columnOffsetValue,
  isLockedColumn,
  moveColumn,
  spacerWidthValue,
  useColumnLayoutDndProps,
} from "../../ui/data-table/column-layout";
import { ColumnResizeHandle } from "../../ui/data-table/column-resize-handle";
import type {
  cubbyTableFeatures,
  CubbyTable as Table,
} from "../../ui/data-table/table-features";
import {
  type ColumnValueKind,
  type CubbyColumnMeta,
  hasColumnFilterEditor,
  requestColumnFilterEdit,
} from "../../ui/data-table/table-meta";

type HeaderStyles = { header: string; sortIcon: string };

const sortIcon = (direction: false | "asc" | "desc", styles: HeaderStyles) =>
  direction === "desc" ? (
    <ArrowDownIcon className={styles.sortIcon} aria-hidden="true" />
  ) : direction === "asc" ? (
    <ArrowUpIcon className={styles.sortIcon} aria-hidden="true" />
  ) : null;

const ariaSort = (direction: false | "asc" | "desc") => {
  if (direction === "asc") return "ascending";
  if (direction === "desc") return "descending";
  return "none";
};

function isStringHeader(value: unknown): value is string {
  return typeof value === "string";
}

function sortableHeaderLabel<TData extends RowData>(
  header: Header<typeof cubbyTableFeatures, TData, unknown>,
) {
  const definition = header.column.columnDef.header;
  return isStringHeader(definition) ? definition : humanize(header.column.id);
}

/**
 * A header label that wraps to two lines, then clamps. `data-header-label`
 * lets column fitting measure it at its two-line width.
 */
export function HeaderLabel({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span
      data-header-label=""
      className="line-clamp-2 min-w-0 leading-[14px] break-words whitespace-normal"
      title={label}
    >
      {children}
    </span>
  );
}

/**
 * What a header paints for its label: the counted entity's icon and "#"
 * when no other visible column counts the same entity, else its short label,
 * led by the linked entity's icon when every cell links to one entity.
 */
function headerContent<TData extends RowData>(
  header: Header<typeof cubbyTableFeatures, TData, unknown>,
) {
  if (header.isPlaceholder) return null;
  const meta = header.column.columnDef.meta;
  const countOf = meta?.countOf;
  const unique =
    countOf !== undefined &&
    header
      .getContext()
      .table.getVisibleLeafColumns()
      .every(
        (column) =>
          column.id === header.column.id ||
          column.columnDef.meta?.countOf !== countOf,
      );
  if (unique)
    return (
      <span data-header-count="" className="inline-flex items-center gap-px">
        <EntityIcon entity={countOf} aria-hidden="true" className="size-3.5" />
        <span aria-hidden="true">#</span>
      </span>
    );
  const label =
    meta?.shortHeader ??
    flexRender(header.column.columnDef.header, header.getContext());
  if (!meta?.linksTo) {
    const Glyph = valueKindGlyph(columnValueKind(meta));
    if (Glyph === null) return label;
    return (
      <>
        <span
          data-header-kind=""
          className="mr-1 inline-flex align-[-2px] text-muted-foreground/70"
        >
          <Glyph aria-hidden="true" className="size-3" />
        </span>
        {label}
      </>
    );
  }
  return (
    <>
      <span data-header-entity="" className="mr-1 inline-flex align-[-2px]">
        <EntityIcon
          entity={meta.linksTo}
          aria-hidden="true"
          className="size-3.5"
        />
      </span>
      {label}
    </>
  );
}

/**
 * An empty column's header: its kind glyph, else its initial, with the full
 * label kept for assistive tech and the tooltip.
 */
function CollapsedHeaderLabel<TData extends RowData>({
  header,
  label,
}: {
  header: Header<typeof cubbyTableFeatures, TData, unknown>;
  label: string;
}) {
  const meta = header.column.columnDef.meta;
  const Glyph = valueKindGlyph(columnValueKind(meta));
  return (
    <span
      data-header-label=""
      className="inline-flex min-w-0 items-center text-muted-foreground/70"
      title={`${label} · empty in these rows`}
    >
      {meta?.linksTo ? (
        <EntityIcon
          entity={meta.linksTo}
          aria-hidden="true"
          className="size-3.5"
        />
      ) : Glyph ? (
        <Glyph aria-hidden="true" className="size-3" />
      ) : (
        <span aria-hidden="true">{label.charAt(0)}</span>
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

type ColumnMeta = CubbyColumnMeta | undefined;

/** A declared kind, else one derived from the column's numeric and filter metadata. */
function columnValueKind(meta: ColumnMeta): ColumnValueKind | null {
  if (meta?.valueKind) return meta.valueKind;
  const filter = meta?.filterConfig;
  if (filter?.dateRange) return "date";
  if (meta?.numeric) return "number";
  if (filter?.filterType === "multiselect" || filter?.filterType === "select")
    return "enum";
  return null;
}

/** Text carries no glyph: it is the default a reader assumes. */
function valueKindGlyph(kind: ColumnValueKind | null) {
  switch (kind) {
    case "date":
      return CalendarBlankIcon;
    case "money":
      return CurrencyDollarIcon;
    case "number":
      return HashIcon;
    case "enum":
      return ListChecksIcon;
    case "person":
      return UserIcon;
    case "boolean":
      return ToggleLeftIcon;
    default:
      return null;
  }
}

/**
 * The column's own menu: sort, filter, group, pin and hide in one place. The
 * caret appears on hover or focus over the header's free edge, so it takes no
 * width at rest. "Filter…" asks the filter bar (the one editor owner) to open
 * this column's editor; the URL-backed filter state stays single-owner.
 */
function HeaderMenu<TData extends RowData>({
  header,
  table,
  label,
  numeric,
}: {
  header: Header<typeof cubbyTableFeatures, TData, unknown>;
  table: Table<TData>;
  label: string;
  numeric: boolean;
}) {
  const column = header.column;
  const meta = table.options.meta;
  const canSort = column.getCanSort();
  const sorted = column.getIsSorted();
  const canFilter = column.columnDef.meta?.filterConfig !== undefined;
  const groupChoice = meta?.grouping?.choices.find(
    (choice) => choice.columnId === column.id,
  );
  const grouped =
    groupChoice !== undefined && meta?.grouping?.active === groupChoice.key;
  const canPin = column.getCanPin() && !isLockedColumn(column);
  const pinned = column.getIsPinned();
  const canHide = column.getCanHide() && !isLockedColumn(column);
  if (!canSort && !canFilter && !groupChoice && !canPin && !canHide)
    return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${label} column menu`}
            data-cell-spill-off=""
            className={cn(
              // In flow once shown, not overlaid: an overlay covered a narrow
              // column's sort target and its label. Until then a 1px
              // absolute box, so the fitted width reserves nothing and the
              // menu stays in the accessibility tree.
              "pointer-events-none absolute size-px shrink-0 overflow-hidden rounded-sm text-muted-foreground opacity-0 hover:text-foreground",
              "group-focus-within/th:pointer-events-auto group-focus-within/th:static group-focus-within/th:size-5 group-focus-within/th:opacity-100",
              "group-hover/th:pointer-events-auto group-hover/th:static group-hover/th:size-5 group-hover/th:opacity-100",
              "data-[popup-open]:pointer-events-auto data-[popup-open]:static data-[popup-open]:size-5 data-[popup-open]:opacity-100",
              "pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:size-5 pointer-coarse:opacity-100",
              numeric && "order-first",
            )}
          />
        }
      >
        <CaretDownIcon className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={numeric ? "start" : "end"} className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {canSort && (
            <>
              <DropdownMenuItem
                onClick={() => column.toggleSorting(false, false)}
              >
                <SortAscendingIcon aria-hidden="true" />
                Sort ascending
                {sorted === "asc" && <HeaderMenuCheck />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => column.toggleSorting(true, false)}
              >
                <SortDescendingIcon aria-hidden="true" />
                Sort descending
                {sorted === "desc" && <HeaderMenuCheck />}
              </DropdownMenuItem>
              {sorted && (
                <DropdownMenuItem onClick={() => column.clearSorting()}>
                  <XIcon aria-hidden="true" />
                  Clear sort
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuGroup>
        {canFilter && <ColumnFilterMenuItems table={table} column={column} />}
        {groupChoice && <DropdownMenuSeparator />}
        {groupChoice && (
          <DropdownMenuItem
            onClick={() =>
              meta?.grouping?.onChange(grouped ? null : groupChoice.key)
            }
          >
            <RowsIcon aria-hidden="true" />
            {grouped ? "Ungroup" : `Group by ${groupChoice.label}`}
          </DropdownMenuItem>
        )}
        {(canPin || canHide) && <DropdownMenuSeparator />}
        {canPin && (
          <DropdownMenuItem
            onClick={() => column.pin(pinned ? false : "start")}
          >
            {pinned ? (
              <PushPinSlashIcon aria-hidden="true" />
            ) : (
              <PushPinIcon aria-hidden="true" />
            )}
            {pinned ? "Unpin" : "Pin to start"}
          </DropdownMenuItem>
        )}
        {canHide && (
          <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
            <EyeSlashIcon aria-hidden="true" />
            Hide column
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Rendered when the menu opens, after the filter bar has subscribed, so a
 * table without a bar never offers an editor it cannot open.
 */
function ColumnFilterMenuItems<TData extends RowData>({
  table,
  column,
}: {
  table: Table<TData>;
  column: Header<typeof cubbyTableFeatures, TData, unknown>["column"];
}) {
  if (!hasColumnFilterEditor(table)) return null;
  const filtered = column.getIsFiltered();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => requestColumnFilterEdit(table, column.id)}
      >
        <FunnelSimpleIcon aria-hidden="true" />
        {filtered ? "Edit filter…" : "Filter…"}
      </DropdownMenuItem>
      {filtered && (
        <DropdownMenuItem onClick={() => column.setFilterValue(undefined)}>
          <XIcon aria-hidden="true" />
          Clear filter
        </DropdownMenuItem>
      )}
    </>
  );
}

function HeaderMenuCheck() {
  return (
    <CheckIcon
      className="ml-auto size-3.5 text-muted-foreground"
      aria-label="Active"
    />
  );
}

function pinBoundaryClass<TData extends RowData>(
  header: Header<typeof cubbyTableFeatures, TData, unknown>,
) {
  const pinned = header.column.getIsPinned();
  if (!pinned) return undefined;
  const columns =
    pinned === "start"
      ? header.getContext().table.getStartVisibleLeafColumns()
      : header.getContext().table.getEndVisibleLeafColumns();
  const index = columns.findIndex((column) => column.id === header.column.id);
  return pinned === "start" && index === columns.length - 1
    ? "table-pinned-boundary-start"
    : pinned === "end" && index === 0
      ? "table-pinned-boundary-end"
      : undefined;
}

/**
 * The hover arrow and source icon, over the header's free edge while it is
 * hovered or focused: the label's end, or a numeric label's start.
 */
function HeaderHoverChrome({
  provenance,
  sortable,
  numeric,
  styles,
}: {
  provenance: EntityFieldProvenance | null | undefined;
  sortable: boolean;
  numeric: boolean;
  styles: HeaderStyles;
}) {
  if (!provenance && !sortable) return null;
  return (
    <span
      data-header-chrome=""
      // A rail, so a clipped label's spill-over draws it past the label.
      data-cell-rail=""
      className={cn(
        // Pointer-transparent so a click still sorts; the source icon keeps
        // its own pointer for its phrase.
        "pointer-events-none invisible absolute inset-y-0 my-auto flex h-5 items-center gap-1 rounded-sm bg-card px-0.5 group-focus-within/th:visible group-hover/th:visible [&_[data-field-provenance]]:pointer-events-auto",
        // Clear of the column menu caret at the same edge.
        numeric
          ? "left-6 shadow-[6px_0_6px_var(--card)]"
          : "right-6 shadow-[-6px_0_6px_var(--card)]",
      )}
    >
      <FieldProvenance compact provenance={provenance} />
      {sortable && (
        <ArrowsDownUpIcon
          className={cn(styles.sortIcon, "opacity-60")}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function SortableHeader<TData extends RowData>({
  header,
  table,
  collapsed,
  styles,
}: {
  header: Header<typeof cubbyTableFeatures, TData, unknown>;
  table: Table<TData>;
  collapsed: boolean;
  styles: HeaderStyles;
}) {
  const locked = isLockedColumn(header.column);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: header.column.id, disabled: locked });
  const sortDirection = header.column.getIsSorted();
  const canSort = header.column.getCanSort();
  const numeric = header.column.columnDef.meta?.numeric ?? false;
  const pinned = header.column.getIsPinned();
  const width = columnWidthValue(header.column.id);
  const provenance = header.column.columnDef.meta?.provenance;
  const headerLabel = sortableHeaderLabel(header);

  // The label wraps to at most two 14px lines inside the 32px header, so a
  // long label no longer sets its column's width. Only a sorted column's
  // arrow takes width; the hover arrow and the source icon overlay the
  // header's free edge while it is hovered or focused, so the column is as
  // narrow as its label or values.
  const title = (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1",
        // Numeric labels end flush with their right-aligned values; the sort
        // arrow leads instead of pushing the label off that edge.
        numeric && "flex-row-reverse",
      )}
    >
      {collapsed ? (
        <CollapsedHeaderLabel header={header} label={headerLabel} />
      ) : (
        <HeaderLabel label={headerLabel}>{headerContent(header)}</HeaderLabel>
      )}
      {header.column.getIsFiltered() && (
        <FunnelSimpleIcon
          data-header-filtered=""
          className="size-3 shrink-0 text-info"
          aria-label="Filtered"
        />
      )}
      {sortIcon(sortDirection, styles)}
      {sortDirection && table.state.sorting.length > 1 && (
        <span className="text-3xs text-muted-foreground tabular-nums">
          {header.column.getSortIndex() + 1}
        </span>
      )}
    </span>
  );
  const hoverChrome = (
    <HeaderHoverChrome
      provenance={provenance}
      sortable={canSort && !sortDirection}
      numeric={numeric}
      styles={styles}
    />
  );

  return (
    <TableHead
      ref={setNodeRef}
      key={header.id}
      data-column-id={header.column.id}
      data-column-collapsed={collapsed ? "" : undefined}
      colSpan={header.colSpan}
      aria-sort={ariaSort(sortDirection)}
      className={cn(
        "group/th relative",
        styles.header,
        "px-1",
        numeric && "text-right",
        header.column.columnDef.meta?.className,
        // meta.className styles the column's cells (e.g. mono for codes);
        // headers keep one typeface across the row.
        "font-sans",
        sortDirection && "bg-muted/50",
        pinned && "sticky z-40 bg-card",
        pinBoundaryClass(header),
        isDragging && "z-50 opacity-70",
      )}
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        transform: CSS.Translate.toString(transform),
        transition,
        ...(pinned === "start"
          ? {
              insetInlineStart: columnOffsetValue(
                table.getStartVisibleLeafColumns(),
                header.column.id,
                "start",
              ),
            }
          : pinned === "end"
            ? {
                insetInlineEnd: columnOffsetValue(
                  table.getEndVisibleLeafColumns(),
                  header.column.id,
                  "end",
                ),
              }
            : {}),
      }}
    >
      <div className="flex min-w-0 items-center">
        {!locked && (
          // Overlays the leading padding instead of taking layout width, so
          // header labels start on the same x as their cells' values. Above
          // a numeric header's leading menu caret, which shares that edge.
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Reorder ${header.column.id} column`}
            data-cell-spill-off=""
            className="absolute inset-y-0 left-0 z-10 my-auto h-5 w-2 shrink-0 cursor-grab touch-none rounded-none px-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/th:opacity-100 group-hover/th:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
            {...attributes}
            {...listeners}
          >
            <DotsSixVerticalIcon className="size-3" />
          </Button>
        )}
        {canSort ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Sort by ${headerLabel}`}
            className={cn(
              "group -mx-1 h-6 min-w-0 flex-1 gap-1 px-1 py-0 font-[inherit] text-[length:inherit] tracking-[inherit] select-none hover:bg-muted/60 hover:text-foreground",
              numeric ? "justify-end" : "justify-start",
            )}
            onClick={header.column.getToggleSortingHandler()}
          >
            {title}
          </Button>
        ) : (
          <span className="inline-flex min-w-0 flex-1 items-center">
            {title}
          </span>
        )}
        {hoverChrome}
        {!collapsed && (
          <HeaderMenu
            header={header}
            table={table}
            label={headerLabel}
            numeric={numeric}
          />
        )}
      </div>
      {header.column.getCanResize() && (
        <ColumnResizeHandle
          onResizeStart={(event) => {
            // A flexible column paints wider than its configured size (it
            // shares pane slack). Seed the painted width first so the drag
            // starts from what the person sees instead of snapping narrower.
            const painted = Math.round(
              event.currentTarget.parentElement?.getBoundingClientRect()
                .width ?? 0,
            );
            if (painted > 0 && painted !== header.column.getSize()) {
              table.setColumnSizing((sizing) => ({
                ...sizing,
                [header.column.id]: painted,
              }));
            }
            header.getResizeHandler()(event);
          }}
          onReset={() => header.column.resetSize()}
        />
      )}
    </TableHead>
  );
}

export default function TableHeaderLayout<TData extends RowData>({
  table,
  collapsedColumns,
  styles,
  isDebugEnabled,
}: {
  table: Table<TData>;
  /** Empty columns painted as a glyph strip; see `emptyColumnIds`. */
  collapsedColumns?: ReadonlySet<string>;
  styles: HeaderStyles;
  isDebugEnabled: boolean;
}) {
  const dndProps = useColumnLayoutDndProps("column position");
  // Header drags stay inside their pin region; the customizer moves columns
  // between regions.
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    moveColumn(table, {
      kind: "reorder",
      id: String(active.id),
      over: String(over.id),
    });
  };

  const start = table.getStartHeaderGroups();
  const center = table.getCenterHeaderGroups();
  const end = table.getEndHeaderGroups();
  const depth = Math.max(start.length, center.length, end.length);

  return (
    <DndContext
      {...dndProps}
      modifiers={[restrictToHorizontalAxis]}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={table.getVisibleLeafColumns().map((column) => column.id)}
        strategy={horizontalListSortingStrategy}
      >
        {Array.from({ length: depth }, (_, index) => {
          const leading = [
            ...(start[index]?.headers ?? []),
            ...(center[index]?.headers ?? []),
          ];
          const trailing = end[index]?.headers ?? [];
          const renderHeader = (header: (typeof leading)[number]) => (
            <SortableHeader
              key={header.id}
              header={header}
              table={table}
              collapsed={collapsedColumns?.has(header.column.id) ?? false}
              styles={styles}
            />
          );
          return (
            <TableRow
              key={[...leading, ...trailing]
                .map((header) => header.id)
                .join(":")}
              className="border-b border-border/50"
            >
              {leading.map(renderHeader)}
              {/* The spacer sits before the end-pinned columns so row actions
                  stay at the table's right edge instead of floating mid-row
                  ahead of an empty gutter. */}
              <TableHead
                data-spacer
                aria-hidden
                scope={undefined}
                className={cn(styles.header, "px-0")}
                style={{ width: spacerWidthValue }}
              />
              {trailing.map(renderHeader)}
              {isDebugEnabled && (
                <TableHead className={styles.header}>Debug</TableHead>
              )}
            </TableRow>
          );
        })}
      </SortableContext>
    </DndContext>
  );
}
