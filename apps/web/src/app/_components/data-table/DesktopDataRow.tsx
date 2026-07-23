import { flexRender, type Row } from "@tanstack/react-table";
import { Bug } from "lucide-react";
import { type MouseEvent, memo } from "react";
import { Button } from "~/components/ui/button";
import { TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { NON_SELECTABLE_COLUMN_IDS } from "./cell-selection-context";
import { DebugDialog } from "./DebugDialog";
import type { RowCellSelection } from "./useCellSelection";

const NUMERIC_CELL = "text-right font-mono tabular-nums";
const MONO_CELL = "font-mono";

export interface DesktopDataRowProps<TItem> {
  row: Row<TItem>;
  /**
   * Flat index of this row within the controller's `rows` array — the
   * coordinate space cell selection uses (may differ from `row.index` under
   * grouping/expansion). Tags the `<tr>` with `data-cell-row` and is compared
   * against the selection's focus row.
   */
  rowIndex: number;
  isSelected: boolean;
  /**
   * Snapshot of `row.getIsExpanded()` taken at parent render time (same
   * pattern as `isSelected`). Exists purely for the memo compare — calling
   * `getIsExpanded()` inside `rowPropsAreEqual` is useless because it's a live
   * read of CURRENT table state, so previous vs next always match.
   */
  isExpanded: boolean;
  isFocused: boolean;
  isDebugEnabled: boolean;
  onRowClick?: (row: Row<TItem>) => void;
  onRowHover?: (row: Row<TItem>) => void;
  rowClassName: string;
  cellClassName: string;
  columnsKey: string;
  height?: string;
  /**
   * This row's slice of the current cell selection, or undefined when the row
   * is outside the selection rect. Referentially stable per selection (see
   * `useCellSelection`), so the memo compare below rests on its field values.
   */
  cellSelection?: RowCellSelection;
  /**
   * When true (cell-selection tables), a click landing on an editable cell
   * selects rather than firing the row's onClick — the row-nav/preview open
   * moves to Cmd/Ctrl+Enter. Off for embedded/other uses.
   */
  suppressCellRowClick?: boolean;
}

function DesktopDataRowInner<TItem>({
  row,
  rowIndex,
  isSelected,
  isFocused,
  isDebugEnabled,
  onRowClick,
  onRowHover,
  rowClassName,
  cellClassName,
  height,
  cellSelection,
  suppressCellRowClick,
}: DesktopDataRowProps<TItem>) {
  // Split the selected-columns key once per render (rows in the rect share it).
  const selectedCols = cellSelection
    ? new Set(cellSelection.colsKey.split(","))
    : null;

  const handleRowClick = onRowClick
    ? (e: MouseEvent<HTMLTableRowElement>) => {
        // In cell-selection mode a click on an editable cell selects it (via the
        // container's mousedown delegation); don't also navigate/open the row.
        if (suppressCellRowClick) {
          const td = (e.target as HTMLElement).closest("td[data-cell-col]");
          if (td?.querySelector("[data-cell-edit-trigger]")) return;
        }
        onRowClick(row);
      }
    : undefined;

  return (
    <TableRow
      data-cell-row={rowIndex}
      data-state={isSelected && "selected"}
      className={cn(
        rowClassName,
        onRowClick && "cursor-pointer",
        isFocused && "ring-2 ring-primary/30 ring-inset",
      )}
      onClick={handleRowClick}
      onMouseEnter={onRowHover ? () => onRowHover(row) : undefined}
      style={height ? { height } : undefined}
    >
      {row.getVisibleCells().map((cell) => {
        const selectable = !NON_SELECTABLE_COLUMN_IDS.has(cell.column.id);
        const cellSelected = selectable
          ? (selectedCols?.has(cell.column.id) ?? false)
          : false;
        const cellAnchor =
          cellSelected && cellSelection?.anchorColId === cell.column.id;
        return (
          <TableCell
            key={cell.id}
            data-cell-col={selectable ? cell.column.id : undefined}
            data-cell-selected={cellSelected ? "" : undefined}
            data-cell-anchor={cellAnchor ? "" : undefined}
            className={cn(
              cellClassName,
              cell.column.columnDef.meta?.numeric && NUMERIC_CELL,
              cell.column.columnDef.meta?.mono && MONO_CELL,
              cell.column.columnDef.meta?.className,
              cellSelected && "bg-primary/10",
              cellAnchor && "ring-2 ring-ring ring-inset",
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      })}
      {isDebugEnabled && (
        <TableCell className={cellClassName}>
          <DebugDialog
            data={row.original}
            title={`Debug Data - Row ${row.id}`}
            trigger={
              <Button variant="ghost" size="icon-sm">
                <Bug className="size-4" />
                <span className="sr-only">Debug row data</span>
              </Button>
            }
          />
        </TableCell>
      )}
      <TableCell data-spacer aria-hidden className={cellClassName} />
    </TableRow>
  );
}

function rowPropsAreEqual<TItem>(
  previous: DesktopDataRowProps<TItem>,
  next: DesktopDataRowProps<TItem>,
): boolean {
  return (
    previous.row.original === next.row.original &&
    // Always-equal (false===false) for non-tree tables, so this is inert there;
    // required so a toggled parent's chevron re-renders when its expanded state
    // flips (row.original is unchanged by an expand/collapse). Compares the
    // render-time snapshot prop — see the isExpanded doc comment.
    previous.isExpanded === next.isExpanded &&
    previous.isSelected === next.isSelected &&
    previous.isFocused === next.isFocused &&
    previous.isDebugEnabled === next.isDebugEnabled &&
    previous.onRowClick === next.onRowClick &&
    previous.onRowHover === next.onRowHover &&
    previous.rowClassName === next.rowClassName &&
    previous.cellClassName === next.cellClassName &&
    previous.columnsKey === next.columnsKey &&
    previous.height === next.height &&
    previous.rowIndex === next.rowIndex &&
    previous.suppressCellRowClick === next.suppressCellRowClick &&
    // Field compare (not identity): getRowCellSelection hands each in-rect row a
    // fresh object on every selection change, but its highlight only differs
    // when these two fields do. undefined?.x === undefined handles the
    // in-rect ↔ out-of-rect transitions (object with colsKey "a" vs undefined →
    // "a" !== undefined → correctly re-renders).
    previous.cellSelection?.colsKey === next.cellSelection?.colsKey &&
    previous.cellSelection?.anchorColId === next.cellSelection?.anchorColId
  );
}

export const DesktopDataRow = memo(
  DesktopDataRowInner,
  rowPropsAreEqual,
) as typeof DesktopDataRowInner;
