import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RowData } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  EyeOff,
  GripVertical,
  PanelLeft,
  PanelRight,
  PinOff,
  RotateCcw,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { columnLabel } from "./data-table-view-options";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";

type Region = "start" | "center" | "end";

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
  const regionColumns = columns.filter((item) => regionFor(item) === region);
  const index = regionColumns.findIndex((item) => item.id === column.id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.id, data: { region } });

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
      <span className="truncate text-xs">
        {columnLabel(column)}
        {!column.getIsVisible() && (
          <span className="ml-1 text-muted-foreground">Hidden</span>
        )}
      </span>
      <div className="flex items-center">
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
      <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
        {label}
      </h3>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-9 space-y-1 border border-border border-dashed p-1",
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeColumn = table.getColumn(String(active.id));
    if (!activeColumn) return;
    const targetColumn = table.getColumn(String(over.id));
    const targetRegion = (over.data.current?.region ??
      (targetColumn ? regionFor(targetColumn) : undefined)) as
      | Region
      | undefined;
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

    table.setColumnPinning({
      start: idsByRegion.start,
      end: idsByRegion.end,
    });
    table.setColumnOrder([
      ...idsByRegion.start,
      ...idsByRegion.center,
      ...idsByRegion.end,
    ]);
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
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
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
        Reset layout
      </Button>
    </div>
  );
}
