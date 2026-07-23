import { flexRender, type Row } from "@tanstack/react-table";
import { Bug } from "lucide-react";
import { memo } from "react";
import { Button } from "~/components/ui/button";
import { TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { DebugDialog } from "./DebugDialog";

const NUMERIC_CELL = "text-right font-mono tabular-nums";
const MONO_CELL = "font-mono";

export interface DesktopDataRowProps<TItem> {
  row: Row<TItem>;
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
}

function DesktopDataRowInner<TItem>({
  row,
  isSelected,
  isFocused,
  isDebugEnabled,
  onRowClick,
  onRowHover,
  rowClassName,
  cellClassName,
  height,
}: DesktopDataRowProps<TItem>) {
  return (
    <TableRow
      data-state={isSelected && "selected"}
      className={cn(
        rowClassName,
        onRowClick && "cursor-pointer",
        isFocused && "ring-2 ring-primary/30 ring-inset",
      )}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onMouseEnter={onRowHover ? () => onRowHover(row) : undefined}
      style={height ? { height } : undefined}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell
          key={cell.id}
          className={cn(
            cellClassName,
            cell.column.columnDef.meta?.numeric && NUMERIC_CELL,
            cell.column.columnDef.meta?.mono && MONO_CELL,
            cell.column.columnDef.meta?.className,
          )}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
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
    previous.height === next.height
  );
}

export const DesktopDataRow = memo(
  DesktopDataRowInner,
  rowPropsAreEqual,
) as typeof DesktopDataRowInner;
