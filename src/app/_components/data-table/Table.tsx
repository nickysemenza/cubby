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
import { ArrowDown, ArrowUp, ArrowUpDown, Bug } from "lucide-react";
import { type ReactNode } from "react";
import { SpacedContainer } from "~/components/ui/spaced-container";
import { LoadingContainer } from "~/components/ui/loading-spinner";
import { useDebug } from "~/hooks/useDebug";
import { DebugDialog } from "./DebugDialog";

interface FilterOption {
  value: string;
  label: string;
}

export interface FilterableColumn {
  id: string;
  placeholder: string;
  filterType?: "text" | "select";
  options?: FilterOption[];
}

interface TTableProps<TItem> {
  table: ITable<TItem>;
  additionalFilters?: ReactNode;
  filterableColumns: FilterableColumn[];
  isLoading?: boolean;
}

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const {
    table,
    additionalFilters,
    filterableColumns,
    isLoading = false,
  } = props;

  const { isDebugEnabled } = useDebug();

  return (
    <SpacedContainer space={4}>
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
              {/* Add debug header when debug mode is enabled */}
              {isDebugEnabled && (
                <TableHead>Debug</TableHead>
              )}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell
                colSpan={table.getAllColumns().length + (isDebugEnabled ? 1 : 0)}
                className="h-16 text-center"
              >
                <LoadingContainer />
              </TableCell>
            </TableRow>
          ) : table.getRowModel().rows?.length ? (
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
                {/* Add debug cell when debug mode is enabled */}
                {isDebugEnabled && (
                  <TableCell>
                    <DebugDialog
                      data={row.original}
                      title={`Debug Data - Row ${row.id}`}
                      trigger={
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                          <Bug className="h-4 w-4" />
                          <span className="sr-only">Debug row data</span>
                        </Button>
                      }
                    />
                  </TableCell>
                )}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={table.getAllColumns().length + (isDebugEnabled ? 1 : 0)}
                className="h-16 text-center"
              >
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <DataTablePagination table={table} />
    </SpacedContainer>
  );
}
