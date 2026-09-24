import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  useDroppable,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowDownIcon as ArrowDown } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon as ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { DotsSixVerticalIcon as GripVertical } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { DotsThreeIcon as MoreHorizontal } from "@phosphor-icons/react/dist/csr/DotsThree";
import { EyeSlashIcon as EyeOff } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { PushPinSlashIcon as PinOff } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SidebarIcon as PanelLeft } from "@phosphor-icons/react/dist/csr/Sidebar";
import { SidebarSimpleIcon as PanelRight } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import type { RowData } from "@tanstack/react-table";
import { useId } from "react";
import { z } from "zod";

import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/components/dnd/accessibility";
import { useCubbyDndSensors } from "~/components/dnd/sensors";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

import { isLockedColumn, withLockedEndLast } from "./column-layout";
import { columnLabel } from "./data-table-view-options";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";

const columnRegionSchema = z.enum(["start", "center", "end"]);
type Region = z.infer<typeof columnRegionSchema>;

function dragRegion(
  value: NonNullable<DragEndEvent["over"]>["data"]["current"],
): Region | undefined {
  return columnRegionSchema.safeParse(value?.region).data;
}

function regionFor<TData extends RowData>(column: Column<TData>): Region {
  return column.getIsPinned() || "center";
}

function SortableColumn<TData extends RowData>({
  column,
  columns,
  table,
}: {
  column: Column<TData>;
  columns: Column<TData>[];
  table: Table<TData>;
}) {
  const region = regionFor(column);
  const locked = isLockedColumn(column);
  const regionColumns = columns.filter(
    (item) => regionFor(item) === region && !isLockedColumn(item),
  );
  const index = regionColumns.findIndex((item) => item.id === column.id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
    data: { region },
    disabled: locked,
  });

  const move = (delta: -1 | 1) => {
    const target = regionColumns[index + delta];
    if (!target) return;
    if (region === "start" || region === "end") {
      const pinning = table.state.columnPinning;
      const ids = [...(pinning[region] ?? [])];
      table.setColumnPinning({
        ...pinning,
        [region]: arrayMove(
          ids,
          ids.indexOf(column.id),
          ids.indexOf(target.id),
        ),
      });
      return;
    }
    const order = columns.map((item) => item.id);
    table.setColumnOrder(
      arrayMove(order, order.indexOf(column.id), order.indexOf(target.id)),
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 border border-border bg-background px-1 py-1",
        isDragging && "z-50 opacity-70",
      )}
      data-column-id={column.id}
    >
      {locked ? (
        <span aria-hidden className="size-7" />
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Drag ${columnLabel(column)}`}
          className="cursor-grab touch-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </Button>
      )}
      <span className="truncate text-xs">
        {columnLabel(column)}
        {!column.getIsVisible() && (
          <span className="ml-1 text-muted-foreground">Hidden</span>
        )}
      </span>
      {!locked && (
        <div className="hidden items-center md:flex">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${columnLabel(column)} earlier`}
            disabled={index === 0}
            onClick={() => move(-1)}
          >
            <ArrowUp className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${columnLabel(column)} later`}
            disabled={index === regionColumns.length - 1}
            onClick={() => move(1)}
          >
            <ArrowDown className="size-3" />
          </Button>
          {region !== "start" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Pin ${columnLabel(column)} to start`}
              onClick={() => column.pin("start")}
            >
              <PanelLeft className="size-3" />
            </Button>
          )}
          {region !== "end" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Pin ${columnLabel(column)} to end`}
              onClick={() => column.pin("end")}
            >
              <PanelRight className="size-3" />
            </Button>
          )}
          {region !== "center" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Unpin ${columnLabel(column)}`}
              onClick={() => column.pin(false)}
            >
              <PinOff className="size-3" />
            </Button>
          )}
          {column.getCanHide() && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${column.getIsVisible() ? "Hide" : "Show"} ${columnLabel(column)}`}
              onClick={() => column.toggleVisibility()}
            >
              <EyeOff className="size-3" />
            </Button>
          )}
        </div>
      )}
      {!locked && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label={`Actions for ${columnLabel(column)}`}
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem disabled={index === 0} onClick={() => move(-1)}>
              <ArrowUp className="size-3.5" />
              Move earlier
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === regionColumns.length - 1}
              onClick={() => move(1)}
            >
              <ArrowDown className="size-3.5" />
              Move later
            </DropdownMenuItem>
            {region !== "start" && (
              <DropdownMenuItem onClick={() => column.pin("start")}>
                <PanelLeft className="size-3.5" />
                Pin to start
              </DropdownMenuItem>
            )}
            {region !== "end" && (
              <DropdownMenuItem onClick={() => column.pin("end")}>
                <PanelRight className="size-3.5" />
                Pin to end
              </DropdownMenuItem>
            )}
            {region !== "center" && (
              <DropdownMenuItem onClick={() => column.pin(false)}>
                <PinOff className="size-3.5" />
                Unpin
              </DropdownMenuItem>
            )}
            {column.getCanHide() && (
              <DropdownMenuItem onClick={() => column.toggleVisibility()}>
                <EyeOff className="size-3.5" />
                {column.getIsVisible() ? "Hide" : "Show"} {columnLabel(column)}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function Zone<TData extends RowData>({
  region,
  label,
  columns,
  allColumns,
  table,
}: {
  region: Region;
  label: string;
  columns: Column<TData>[];
  allColumns: Column<TData>[];
  table: Table<TData>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `zone:${region}`,
    data: { region },
  });
  return (
    <section className="space-y-1">
      <h3 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </h3>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-9 space-y-1 border border-dashed border-border p-1",
          isOver && "border-primary bg-primary/5",
        )}
      >
        <SortableContext
          items={columns.map((column) => column.id)}
          strategy={verticalListSortingStrategy}
        >
          {columns.map((column) => (
            <SortableColumn
              key={column.id}
              column={column}
              columns={allColumns}
              table={table}
            />
          ))}
        </SortableContext>
      </div>
    </section>
  );
}

export default function TableLayoutCustomizer<TData extends RowData>({
  table,
}: {
  table: Table<TData>;
}) {
  const columns = table.getAllLeafColumns();
  const sensors = useCubbyDndSensors({ touchDelay: 150, touchTolerance: 5 });
  // Hydration-stable id; see TableHeaderLayout for why the counter default breaks.
  const describedById = `DndDescribedBy-${useId()}`;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeColumn = table.getColumn(String(active.id));
    if (!activeColumn || isLockedColumn(activeColumn)) return;
    const targetColumn = table.getColumn(String(over.id));
    if (targetColumn && isLockedColumn(targetColumn)) return;
    const targetRegion =
      dragRegion(over.data.current) ??
      (targetColumn ? regionFor(targetColumn) : undefined);
    if (!targetRegion) return;

    const idsByRegion = {
      start: columns
        .filter((column) => regionFor(column) === "start")
        .map((column) => column.id),
      center: columns
        .filter((column) => regionFor(column) === "center")
        .map((column) => column.id),
      end: columns
        .filter((column) => regionFor(column) === "end")
        .map((column) => column.id),
    };
    for (const ids of Object.values(idsByRegion)) {
      const index = ids.indexOf(activeColumn.id);
      if (index >= 0) ids.splice(index, 1);
    }
    const targetIds = idsByRegion[targetRegion];
    const targetIndex = targetColumn
      ? targetIds.indexOf(targetColumn.id)
      : targetIds.length;
    targetIds.splice(
      targetIndex < 0 ? targetIds.length : targetIndex,
      0,
      activeColumn.id,
    );

    const actionColumnIds = new Set(
      columns
        .filter(
          (column) => column.columnDef.meta?.entityColumnRole === "action",
        )
        .map((column) => column.id),
    );
    const end = withLockedEndLast(idsByRegion.end, actionColumnIds);
    table.setColumnPinning({ start: idsByRegion.start, end });
    table.setColumnOrder([...idsByRegion.start, ...idsByRegion.center, ...end]);
  };

  const reset = () => {
    const defaults = table.options.meta?.defaultLayout;
    if (!defaults) return;
    table.setColumnOrder(defaults.columnOrder);
    table.setColumnPinning(defaults.columnPinning);
    table.setColumnVisibility(defaults.columnVisibility);
    table.setColumnSizing(defaults.columnSizing);
  };

  return (
    <div className="space-y-2 p-2">
      <DndContext
        id={describedById}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          container: globalThis.document?.body,
          screenReaderInstructions: cubbyDndScreenReaderInstructions,
          announcements: createDndAnnouncements({
            item: (id) => `${id} column`,
            target: (id) => `${id} layout position`,
          }),
        }}
      >
        <Zone
          region="start"
          label="Pinned start"
          columns={columns.filter((column) => regionFor(column) === "start")}
          allColumns={columns}
          table={table}
        />
        <Zone
          region="center"
          label="Unpinned"
          columns={columns.filter((column) => regionFor(column) === "center")}
          allColumns={columns}
          table={table}
        />
        <Zone
          region="end"
          label="Pinned end"
          columns={columns.filter((column) => regionFor(column) === "end")}
          allColumns={columns}
          table={table}
        />
      </DndContext>
      <Button variant="ghost" size="sm" className="w-full" onClick={reset}>
        <RotateCcw className="size-3.5" />
        Restore default layout
      </Button>
    </div>
  );
}
