import { humanize } from "@cubby/shared";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Header, RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, GripVertical } from "lucide-react";
import { useId } from "react";

import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/components/dnd/accessibility";
import { useCubbyDndSensors } from "~/components/dnd/sensors";
import { Button } from "~/components/ui/button";
import { TableHead, TableRow } from "~/components/ui/table";
import { FieldProvenance } from "~/entities/field-provenance";
import { cn } from "~/lib/utils";

import { columnWidthValue, isLockedColumn } from "./column-layout";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import type { cubbyTableFeatures, CubbyTable as Table } from "./table-features";

type HeaderStyles = { header: string; sortIcon: string };

const sortIcon = (
  direction: false | "asc" | "desc",
  canSort: boolean,
  styles: HeaderStyles,
) => {
  if (direction === "desc")
    return <ArrowDown className={styles.sortIcon} aria-hidden="true" />;
  if (direction === "asc")
    return <ArrowUp className={styles.sortIcon} aria-hidden="true" />;
  return canSort ? (
    <ArrowUpDown
      className={cn(styles.sortIcon, "opacity-40 group-hover:opacity-100")}
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

  const title = (
    <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
      <span className="inline-flex min-w-0 items-center gap-1">
        {header.isPlaceholder
          ? null
          : flexRender(header.column.columnDef.header, header.getContext())}
        {sortingArrows}
        {sortDirection && table.state.sorting.length > 1 && (
          <span className="text-3xs text-muted-foreground tabular-nums">
            {header.column.getSortIndex() + 1}
          </span>
        )}
      </span>
      {provenance ? (
        <FieldProvenance
          provenance={provenance}
          className="max-w-full text-[0.625rem] font-normal tracking-normal normal-case"
        />
      ) : null}
    </span>
  );

  return (
    <TableHead
      ref={setNodeRef}
      key={header.id}
      colSpan={header.colSpan}
      aria-sort={ariaSort(sortDirection)}
      className={cn(
        "group/th relative",
        styles.header,
        numeric && "text-right",
        header.column.columnDef.meta?.className,
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
      <div className={cn("flex items-center gap-1", numeric && "justify-end")}>
        {!locked && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Reorder ${header.column.id} column`}
            className="h-6 w-5 shrink-0 cursor-grab touch-none px-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/th:opacity-100 group-hover/th:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3" />
          </Button>
        )}
        {canSort ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Sort by ${headerLabel}`}
            className={cn(
              "group h-auto min-h-6 min-w-0 flex-1 gap-1 px-1 py-1 text-2xs font-semibold tracking-wider uppercase select-none hover:bg-muted/60",
              numeric ? "justify-end" : "justify-start",
            )}
            onClick={header.column.getToggleSortingHandler()}
          >
            {title}
          </Button>
        ) : (
          <span className="inline-flex min-w-0 flex-1 items-start gap-1 py-1">
            {title}
          </span>
        )}
      </div>
      {header.column.getCanResize() && (
        <ColumnResizeHandle
          onResizeStart={header.getResizeHandler()}
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
  const sensors = useCubbyDndSensors({ touchDelay: 150, touchTolerance: 5 });
  // dnd-kit's default `DndDescribedBy-<n>` id comes from a module-level counter
  // that advances differently on the server and the client, so every sortable
  // header's `aria-describedby` hydration-mismatches. `useId` is tree-stable
  // across SSR and hydration; dnd-kit uses a provided `id` verbatim.
  const describedById = `DndDescribedBy-${useId()}`;
  const region = (id: string) => table.getColumn(id)?.getIsPinned() || "center";
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeColumn = table.getColumn(activeId);
    const overColumn = table.getColumn(overId);
    if (
      (activeColumn && isLockedColumn(activeColumn)) ||
      (overColumn && isLockedColumn(overColumn))
    ) {
      return;
    }
    if (region(activeId) !== region(overId)) return;
    const activeRegion = region(activeId);
    if (activeRegion === "start" || activeRegion === "end") {
      const pinning = table.state.columnPinning;
      const ids = [...(pinning[activeRegion] ?? [])];
      const from = ids.indexOf(activeId);
      const to = ids.indexOf(overId);
      if (from >= 0 && to >= 0) {
        table.setColumnPinning({
          ...pinning,
          [activeRegion]: arrayMove(ids, from, to),
        });
      }
      return;
    }
    const order = table.getAllLeafColumns().map((column) => column.id);
    const from = order.indexOf(activeId);
    const to = order.indexOf(overId);
    if (from >= 0 && to >= 0) table.setColumnOrder(arrayMove(order, from, to));
  };

  const start = table.getStartHeaderGroups();
  const center = table.getCenterHeaderGroups();
  const end = table.getEndHeaderGroups();
  const depth = Math.max(start.length, center.length, end.length);

  return (
    <DndContext
      id={describedById}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis]}
      onDragEnd={onDragEnd}
      accessibility={{
        container: globalThis.document?.body,
        screenReaderInstructions: cubbyDndScreenReaderInstructions,
        announcements: createDndAnnouncements({
          item: (id) => `${id} column`,
          target: (id) => `${id} column position`,
        }),
      }}
    >
      <SortableContext
        items={table.getVisibleLeafColumns().map((column) => column.id)}
        strategy={horizontalListSortingStrategy}
      >
        {Array.from({ length: depth }, (_, index) => {
          const headers = [
            ...(start[index]?.headers ?? []),
            ...(center[index]?.headers ?? []),
            ...(end[index]?.headers ?? []),
          ];
          return (
            <TableRow
              key={headers.map((header) => header.id).join(":")}
              className="border-b border-border/50"
            >
              {headers.map((header) => (
                <SortableHeader
                  key={header.id}
                  header={header}
                  table={table}
                  styles={styles}
                />
              ))}
              {isDebugEnabled && (
                <TableHead className={styles.header}>Debug</TableHead>
              )}
              <TableHead
                data-spacer
                aria-hidden
                scope={undefined}
                className={cn(styles.header, "w-0")}
              />
            </TableRow>
          );
        })}
      </SortableContext>
    </DndContext>
  );
}
