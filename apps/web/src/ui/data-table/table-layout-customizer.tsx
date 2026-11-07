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
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import type { RowData } from "@tanstack/react-table";
import { cn } from "cn";
import { useState } from "react";

import { MoreMenuTrigger } from "~/ui/navigation/more-menu-trigger";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { Description } from "~/ui/text/description";

import {
  applyColumnLayout,
  columnRegion,
  type ColumnRegion as Region,
  columnRegionSchema,
  columnsByRegion,
  columnBands,
  isLockedColumn,
  moveColumn,
  useColumnLayoutDndProps,
} from "./column-layout";
import { ColumnEntityMark, columnTypeLabel } from "./column-presentation";
import { useColumnVisibility } from "./column-visibility-context";
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
  const visibility = useColumnVisibility();
  const automatic =
    column.getIsVisible() && visibility.emptyColumns.includes(column.id);
  const shown = column.getIsVisible() && !automatic;
  const toggle = (visible: boolean) => {
    column.toggleVisibility(visible);
    if (visible) visibility.reveal([column.id]);
  };
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
        "grid min-h-(--table-row-height) grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-1 max-md:min-h-11",
        !shown && "bg-muted text-muted-foreground",
        isDragging && "z-50 opacity-70",
      )}
      data-column-id={column.id}
    >
      {locked ? (
        <span aria-hidden className="size-6" />
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
      <Checkbox
        checked={shown}
        disabled={!column.getCanHide()}
        aria-label={`${shown ? "Hide" : "Show"} ${columnLabel(column)}`}
        onCheckedChange={toggle}
      />
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <ColumnEntityMark
          meta={column.columnDef.meta}
          className="size-3.5 shrink-0"
        />
        <span className="truncate">{columnLabel(column)}</span>
        {!shown && (
          <span className="shrink-0 text-2xs">
            {automatic ? "Empty in these rows" : "Hidden"}
          </span>
        )}
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
          {columnTypeLabel(column.columnDef.meta)}
        </span>
        {locked && (
          <span className="text-2xs text-muted-foreground">Fixed</span>
        )}
      </div>
      {!locked && (
        <DropdownMenu>
          <MoreMenuTrigger
            size="icon-sm"
            aria-label={`Actions for ${columnLabel(column)}`}
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                {column.columnDef.meta?.columnGroup
                  ? `Pinning moves ${column.columnDef.meta.columnGroup}`
                  : "Column position"}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
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
              <DropdownMenuItem onClick={() => toggle(!shown)}>
                {shown ? "Hide" : "Show"} {columnLabel(column)}
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
  search,
}: {
  search: string;
  region: Region;
  label: string;
  columns: Column<TData>[];
  table: Table<TData>;
}) {
  const visibility = useColumnVisibility();
  const isShown = (column: Column<TData>) =>
    column.getIsVisible() && !visibility.emptyColumns.includes(column.id);
  const movable = columns.filter((column) => !isLockedColumn(column));
  const bands = columnBands(columns);
  const { setNodeRef, isOver } = useDroppable({
    id: `zone:${region}`,
    data: { region },
  });
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <div
        ref={setNodeRef}
        className={cn("min-h-6", isOver && "border-primary bg-primary/5")}
      >
        <SortableContext
          items={columns.map((column) => column.id)}
          strategy={verticalListSortingStrategy}
        >
          {bands.map(
            (band, bandIndex) =>
              band.columns.some((column) =>
                columnLabel(column).toLowerCase().includes(search),
              ) && (
                <div key={band.columns[0]?.id}>
                  {band.label && (
                    <div className="flex items-center gap-1 px-1 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {band.label}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${band.label} group earlier`}
                        disabled={
                          bandIndex === 0 ||
                          bands[bandIndex - 1]?.columns.some(isLockedColumn)
                        }
                        onClick={() => {
                          const first = band.columns[0];
                          const target = bands[bandIndex - 1]?.columns[0];
                          if (first && target)
                            moveColumn(table, {
                              kind: "reorder-group",
                              id: first.id,
                              over: target.id,
                            });
                        }}
                      >
                        <ArrowUpIcon className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${band.label} group later`}
                        disabled={
                          bandIndex === bands.length - 1 ||
                          bands[bandIndex + 1]?.columns.some(isLockedColumn)
                        }
                        onClick={() => {
                          const first = band.columns[0];
                          const target = bands[bandIndex + 1]?.columns[0];
                          if (first && target)
                            moveColumn(table, {
                              kind: "reorder-group",
                              id: first.id,
                              over: target.id,
                            });
                        }}
                      >
                        <ArrowDownIcon className="size-3" />
                      </Button>
                      <Checkbox
                        aria-label={`Show ${band.label} group`}
                        checked={band.columns.every(isShown)}
                        indeterminate={
                          band.columns.some(isShown) &&
                          !band.columns.every(isShown)
                        }
                        disabled={
                          !band.columns.some((column) => column.getCanHide())
                        }
                        onCheckedChange={(visible) => {
                          table.setColumnVisibility((current) => ({
                            ...current,
                            ...Object.fromEntries(
                              band.columns
                                .filter((column) => column.getCanHide())
                                .map((column) => [column.id, visible]),
                            ),
                          }));
                          if (visible)
                            visibility.reveal(
                              band.columns.map((column) => column.id),
                            );
                        }}
                      />
                    </div>
                  )}
                  {band.columns
                    .filter((column) =>
                      columnLabel(column).toLowerCase().includes(search),
                    )
                    .map((column) => (
                      <SortableColumn
                        key={column.id}
                        column={column}
                        regionColumns={movable.filter(
                          (item) =>
                            item.columnDef.meta?.columnGroup ===
                            column.columnDef.meta?.columnGroup,
                        )}
                        table={table}
                      />
                    ))}
                </div>
              ),
          )}
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
  const visibility = useColumnVisibility();
  const [search, setSearch] = useState("");
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
    if (defaults) {
      applyColumnLayout(table, defaults);
      visibility.reset();
    }
  };

  return (
    <div className="space-y-2 p-2">
      <Input
        aria-label="Search columns"
        placeholder="Search columns…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {table
        .getAllLeafColumns()
        .some((column) => column.columnDef.meta?.columnGroup) && (
        <Description size="xs" className="px-1">
          Move columns within their group. Pinning a grouped column moves its
          whole group.
        </Description>
      )}
      <DndContext {...dndProps} onDragEnd={onDragEnd}>
        <Zone
          search={search.trim().toLowerCase()}
          region="start"
          label="Pinned start"
          columns={columns.start}
          table={table}
        />
        <Zone
          search={search.trim().toLowerCase()}
          region="center"
          label="Unpinned"
          columns={columns.center}
          table={table}
        />
        <Zone
          search={search.trim().toLowerCase()}
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
