"use client";

// cf https://ui.shadcn.com/docs/components/data-table
import { flexRender, type Table as ITable } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { DataTableToolbar } from "./data-table-toolbar";
import { DataTablePagination } from "./data-table-pagination";
import { Button } from "~/components/ui/button";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type ReactNode } from "react";

interface TTableProps<TItem> {
  table: ITable<TItem>;
  additionalFilters?: ReactNode;
  filterableColumns: {
    id: string;
    placeholder: string;
  }[];
}

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const { table, additionalFilters, filterableColumns } = props;
  
  return (
    <div className="space-y-4">
      <DataTableToolbar 
        table={table} 
        additionalFilters={additionalFilters}
        filterableColumns={filterableColumns}
      />
      <Table aria-label="Tasks">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sortDirection = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                const sortingArrows =
                  sortDirection === "desc" ? (
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  ) : sortDirection === "asc" ? (
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
                  );

                const contents = (
                  <>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                    {canSort && sortingArrows}
                  </>
                );
                return (
                  <TableHead key={header.id} colSpan={header.colSpan}>
                    {canSort ? (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          header.column.toggleSorting(
                            header.column.getIsSorted() === "asc",
                          )
                        }
                      >
                        {contents}
                      </Button>
                    ) : (
                      contents
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && "selected"}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={table.getAllColumns.length}
                className="h-24 text-center"
              >
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <DataTablePagination table={table} />
    </div>
  );
}
