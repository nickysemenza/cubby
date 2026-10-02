import type { ReactNode } from "react";

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
  cell: (row: T) => ReactNode;
  headClassName?: string;
  cellClassName?: string;
}

/**
 * A read-only table over `rows`: header cells, one row per record, no sorting,
 * paging, or column layout. Interactive lists use `RTable`; this only removes
 * the thead/tbody boilerplate for small static panels built on the Table
 * primitives.
 */
export function StaticTable<T>({
  rows,
  columns,
  rowKey,
  className,
  containerClassName,
  headClassName,
  cellClassName,
  rowClassName,
}: {
  rows: readonly T[];
  columns: readonly StaticTableColumn<T>[];
  rowKey: (row: T) => string;
  className?: string;
  containerClassName?: string;
  /** Applied to every header cell, before the column's own. */
  headClassName?: string;
  /** Applied to every body cell, before the column's own. */
  cellClassName?: string;
  rowClassName?: string;
}) {
  return (
    <Table className={className} containerClassName={containerClassName}>
      <TableHeader>
        <TableRow className={rowClassName}>
          {columns.map((column) => (
            <TableHead
              key={column.id}
              className={cn(headClassName, column.headClassName)}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rowKey(row)} className={rowClassName}>
            {columns.map((column) => (
              <TableCell
                key={column.id}
                className={cn(cellClassName, column.cellClassName)}
              >
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
