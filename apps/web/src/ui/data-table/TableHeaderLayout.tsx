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
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import type { Header, RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { EntityIcon } from "~/entity/entities";
import { FieldProvenance } from "~/entity/field-provenance";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";
import { TableHead, TableRow } from "~/ui/primitives/table";

import {
  columnWidthValue,
  columnOffsetValue,
  isLockedColumn,
  moveColumn,
  spacerWidthValue,
  useColumnLayoutDndProps,
} from "./column-layout";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import type { cubbyTableFeatures, CubbyTable as Table } from "./table-features";

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
 * when no other visible column counts the same entity, else its short label.
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
  return (
    meta?.shortHeader ??
    flexRender(header.column.columnDef.header, header.getContext())
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
      className={cn(
        // Pointer-transparent so a click still sorts; the source icon keeps
        // its own pointer for its phrase.
        "pointer-events-none invisible absolute inset-y-0 my-auto flex h-5 items-center gap-1 rounded-sm bg-card px-0.5 group-focus-within/th:visible group-hover/th:visible [&_[data-field-provenance]]:pointer-events-auto",
        numeric
          ? "left-1 shadow-[6px_0_6px_var(--card)]"
          : "right-1.5 shadow-[-6px_0_6px_var(--card)]",
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
  styles,
}: {
  header: Header<typeof cubbyTableFeatures, TData, unknown>;
  table: Table<TData>;
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
      <HeaderLabel label={headerLabel}>{headerContent(header)}</HeaderLabel>
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
          // header labels start on the same x as their cells' values.
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Reorder ${header.column.id} column`}
            className="absolute inset-y-0 left-0 my-auto h-5 w-2 shrink-0 cursor-grab touch-none rounded-none px-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/th:opacity-100 group-hover/th:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
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
  styles,
  isDebugEnabled,
}: {
  table: Table<TData>;
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
