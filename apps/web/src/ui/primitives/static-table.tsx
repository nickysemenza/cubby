import type { ComponentProps, ReactNode } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { cn } from "~/lib/utils";

export interface StaticTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  headClassName?: string;
  cellClassName?: string;
  headProps?: ComponentProps<"th">;
  /** Null omits a cell covered by an earlier column's span. */
  cellProps?: (row: T, index: number) => ComponentProps<"td"> | null;
  rowHeader?: boolean;
  hidden?: boolean;
}

/** Static reports share table geometry; interactive record lists use RTable. */
export function StaticTable<T>({
  rows,
  columns,
  rowKey,
  className,
  containerClassName,
  headClassName,
  cellClassName,
  rowClassName,
  hideHeader = false,
  emptyMessage,
  ...tableProps
}: Omit<ComponentProps<"table">, "children"> & {
  rows: readonly T[];
  columns: readonly StaticTableColumn<T>[];
  rowKey: (row: T, index: number) => string;
  containerClassName?: string;
  /** Applied to every header cell, before the column's own. */
  headClassName?: string;
  /** Applied to every body cell, before the column's own. */
  cellClassName?: string;
  rowClassName?: string | ((row: T, index: number) => string | undefined);
  hideHeader?: boolean;
  emptyMessage?: ReactNode;
}) {
  const visibleColumns = columns.filter((column) => !column.hidden);
  return (
    <Table
      {...tableProps}
      className={className}
      containerClassName={containerClassName}
    >
      {!hideHeader && (
        <TableHeader>
          <TableRow
            className={
              typeof rowClassName === "string" ? rowClassName : undefined
            }
          >
            {visibleColumns.map((column) => (
              <TableHead
                key={column.id}
                {...column.headProps}
                className={cn(
                  headClassName,
                  column.headClassName,
                  column.headProps?.className,
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {rows.map((row, index) => (
          <TableRow
            key={rowKey(row, index)}
            className={
              typeof rowClassName === "function"
                ? rowClassName(row, index)
                : rowClassName
            }
          >
            {visibleColumns.map((column) => {
              const props = column.cellProps?.(row, index);
              if (props === null) return null;
              const Cell = column.rowHeader ? TableHead : TableCell;
              return (
                <Cell
                  key={column.id}
                  scope={column.rowHeader ? "row" : undefined}
                  {...props}
                  className={cn(
                    cellClassName,
                    column.cellClassName,
                    props?.className,
                  )}
                >
                  {column.cell(row, index)}
                </Cell>
              );
            })}
          </TableRow>
        ))}
        {rows.length === 0 && emptyMessage != null && (
          <TableRow>
            <TableCell
              colSpan={visibleColumns.length}
              className="text-muted-foreground"
            >
              {emptyMessage}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
