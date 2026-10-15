import { DndContext, type DragEndEvent, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import type { RowData } from "@tanstack/react-table";

import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import {
  applyColumnLayout,
  columnRegion,
  type ColumnRegion as Region,
  columnRegionSchema,
  columnsByRegion,
  isLockedColumn,
  moveColumn,
  useColumnLayoutDndProps,
} from "./column-layout";
import { columnLabel } from "./data-table-view-options";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";

function dragRegion(
  value: NonNullable<DragEndEvent["over"]>["data"]["current"],
): Region | undefined {
  return columnRegionSchema.safeParse(value?.region).data;
}

function SortableColumn<TData extends RowData>({
  column,
  regionColumns,
  table,
}: {
  column: Column<TData>;
  /** The movable columns of this column's region, in display order. */
  regionColumns: Column<TData>[];
  table: Table<TData>;
}) {
  const region = columnRegion(column);
  const locked = isLockedColumn(column);
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
    if (target) {
      moveColumn(table, { kind: "reorder", id: column.id, over: target.id });
    }
  };
  const pin = (to: Region) =>
    moveColumn(table, { kind: "place", id: column.id, region: to });

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
          <DotsSixVerticalIcon className="size-3.5" />
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
            <ArrowUpIcon className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${columnLabel(column)} later`}
            disabled={index === regionColumns.length - 1}
            onClick={() => move(1)}
          >
            <ArrowDownIcon className="size-3" />
          </Button>
          {region !== "start" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Pin ${columnLabel(column)} to start`}
              onClick={() => pin("start")}
            >
              <SidebarIcon className="size-3" />
            </Button>
          )}
          {region !== "end" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Pin ${columnLabel(column)} to end`}
              onClick={() => pin("end")}
            >
              <SidebarSimpleIcon className="size-3" />
            </Button>
          )}
          {region !== "center" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Unpin ${columnLabel(column)}`}
              onClick={() => pin("center")}
            >
              <PushPinSlashIcon className="size-3" />
            </Button>
          )}
          {column.getCanHide() && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${column.getIsVisible() ? "Hide" : "Show"} ${columnLabel(column)}`}
              onClick={() => column.toggleVisibility()}
            >
              <EyeSlashIcon className="size-3" />
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
            <DotsThreeIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem disabled={index === 0} onClick={() => move(-1)}>
              <ArrowUpIcon className="size-3.5" />
              Move earlier
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === regionColumns.length - 1}
              onClick={() => move(1)}
            >
              <ArrowDownIcon className="size-3.5" />
              Move later
            </DropdownMenuItem>
            {region !== "start" && (
              <DropdownMenuItem onClick={() => pin("start")}>
                <SidebarIcon className="size-3.5" />
                Pin to start
              </DropdownMenuItem>
            )}
            {region !== "end" && (
              <DropdownMenuItem onClick={() => pin("end")}>
                <SidebarSimpleIcon className="size-3.5" />
                Pin to end
              </DropdownMenuItem>
            )}
            {region !== "center" && (
              <DropdownMenuItem onClick={() => pin("center")}>
                <PushPinSlashIcon className="size-3.5" />
                Unpin
              </DropdownMenuItem>
            )}
            {column.getCanHide() && (
              <DropdownMenuItem onClick={() => column.toggleVisibility()}>
                <EyeSlashIcon className="size-3.5" />
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
  table,
}: {
  region: Region;
  label: string;
  columns: Column<TData>[];
  table: Table<TData>;
}) {
  const movable = columns.filter((column) => !isLockedColumn(column));
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
              regionColumns={movable}
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
  const columns = columnsByRegion(table);
  const dndProps = useColumnLayoutDndProps("layout position");

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const target = table.getColumn(String(over.id));
    const region =
      dragRegion(over.data.current) ?? (target && columnRegion(target));
    if (!region) return;
    moveColumn(table, {
      kind: "place",
      id: String(active.id),
      region,
      over: target?.id,
    });
  };

  const reset = () => {
    const defaults = table.options.meta?.defaultLayout;
    if (defaults) applyColumnLayout(table, defaults);
  };

  return (
    <div className="space-y-2 p-2">
      <DndContext {...dndProps} onDragEnd={onDragEnd}>
        <Zone
          region="start"
          label="Pinned start"
          columns={columns.start}
          table={table}
        />
        <Zone
          region="center"
          label="Unpinned"
          columns={columns.center}
          table={table}
        />
        <Zone
          region="end"
          label="Pinned end"
          columns={columns.end}
          table={table}
        />
      </DndContext>
      <Button variant="ghost" size="sm" className="w-full" onClick={reset}>
        <ArrowCounterClockwiseIcon className="size-3.5" />
        Restore default layout
      </Button>
    </div>
  );
}
