import { humanize } from "@cubby/shared/text-case";
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

import { FieldProvenance } from "~/entity/field-provenance";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";
import { TableHead, TableRow } from "~/ui/primitives/table";

import {
  columnWidthValue,
  isLockedColumn,
  moveColumn,
  spacerWidthValue,
  useColumnLayoutDndProps,
} from "./column-layout";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import type { cubbyTableFeatures, CubbyTable as Table } from "./table-features";

type HeaderStyles = { header: string; sortIcon: string };

const sortIcon = (
  direction: false | "asc" | "desc",
  canSort: boolean,
  styles: HeaderStyles,
) => {
  if (direction === "desc")
    return <ArrowDownIcon className={styles.sortIcon} aria-hidden="true" />;
  if (direction === "asc")
    return <ArrowUpIcon className={styles.sortIcon} aria-hidden="true" />;
  return canSort ? (
    <ArrowsDownUpIcon
      className={cn(
        styles.sortIcon,
        "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60",
      )}
      aria-hidden="true"
    />
  ) : null;
};

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
  const sortingArrows = sortIcon(sortDirection, canSort, styles);
  const provenance = header.column.columnDef.meta?.provenance;
  const headerLabel = sortableHeaderLabel(header);

  // One line, always: the label truncates with an ellipsis and the column's
  // source collapses to an icon whose phrase is the tooltip. The old second
  // "From …" line made headers two rows tall and truncated to noise.
  const title = (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1",
        // Numeric labels end flush with their right-aligned values; the sort
        // arrow leads instead of pushing the label off that edge.
        numeric && "flex-row-reverse",
      )}
    >
      <span className="min-w-0 truncate" title={headerLabel}>
        {header.isPlaceholder
          ? null
          : flexRender(header.column.columnDef.header, header.getContext())}
      </span>
      <FieldProvenance compact provenance={provenance} />
      {sortingArrows}
      {sortDirection && table.state.sorting.length > 1 && (
        <span className="text-3xs text-muted-foreground tabular-nums">
          {header.column.getSortIndex() + 1}
        </span>
      )}
    </span>
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
          ? { insetInlineStart: header.column.getStart("start") }
          : pinned === "end"
            ? { insetInlineEnd: header.column.getAfter("end") }
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
