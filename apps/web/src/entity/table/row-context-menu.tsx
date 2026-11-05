import type { RowData } from "@tanstack/react-table";
import { type MouseEvent, useMemo, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
} from "~/ui/primitives/dropdown-menu";

import { useCoarsePointer } from "../../ui/data-table/row-activity";
import type {
  CubbyRow as Row,
  CubbyTable as ITable,
} from "../../ui/data-table/table-features";

/**
 * Native editing and selection menus win over the row's, and Shift asks for the
 * browser's. Ctrl is not an escape hatch: on a Mac, Ctrl+click is the right-click.
 */
function keepsNativeMenu(event: MouseEvent<HTMLElement>) {
  if (event.shiftKey) return true;
  if (
    event.target instanceof Element &&
    event.target.closest("input, textarea, [contenteditable=true]")
  )
    return true;
  return window.getSelection()?.isCollapsed === false;
}

/**
 * The desktop right-click menu: the row's own action roster, the one its actions
 * column declares, at the pointer. A single menu serves the table so a virtualized
 * row never carries its own instance. Touch keeps its long-press and phone cards
 * never reach this.
 */
export function useRowContextMenu<TItem extends RowData>(
  table: ITable<TItem>,
  rows: readonly Row<TItem>[],
) {
  const coarse = useCoarsePointer();
  const [target, setTarget] = useState<{
    row: Row<TItem>;
    x: number;
    y: number;
  } | null>(null);
  const items = table
    .getAllLeafColumns()
    .find((column) => column.columnDef.meta?.entityColumnRole === "action")
    ?.columnDef.meta?.rowMenu;
  const anchor = useMemo(
    () =>
      target && {
        getBoundingClientRect: () =>
          DOMRect.fromRect({ x: target.x, y: target.y, width: 0, height: 0 }),
      },
    [target],
  );
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!items || coarse || keepsNativeMenu(event)) return;
    const element =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("tr[data-cell-row]")
        : null;
    const row = rows[Number(element?.dataset.cellRow)];
    if (!row) return;
    event.preventDefault();
    setTarget({ row, x: event.clientX, y: event.clientY });
  };
  const menu =
    target && items && anchor ? (
      <DropdownMenu
        open
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <DropdownMenuContent
          anchor={anchor}
          align="start"
          sideOffset={0}
          className="w-auto min-w-44"
          aria-label="Row actions"
          onClick={(event) => event.stopPropagation()}
        >
          {items(target.row.original)}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  return { onContextMenu, menu };
}
