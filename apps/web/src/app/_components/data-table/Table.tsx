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
import type { ReactNode } from "react";
import { SpacedContainer } from "~/components/layout/spaced-container";
import { Spinner } from "~/components/ui/spinner";
import { Empty, EmptyTitle, EmptyDescription } from "~/components/ui/empty";
import { useDebug } from "~/hooks/useDebug";
import { DebugDialog } from "./DebugDialog";
import { MobileCardView } from "./MobileCardView";
import { ErrorDisplay } from "~/components/feedback/error-display";

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
  error?: unknown;
  ariaLabel?: string;
}

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const {
    table,
    additionalFilters,
    filterableColumns,
    isLoading = false,
    error,
    ariaLabel = "Data Table",
  } = props;

  const { isDebugEnabled } = useDebug();

  return (
    <SpacedContainer space={4}>
      <DataTableToolbar
        table={table}
        additionalFilters={additionalFilters}
        filterableColumns={filterableColumns}
      />

      {/* Desktop Table View */}
      <Table aria-label={ariaLabel}>
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
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    aria-sort={
                      sortDirection === "asc"
                        ? "ascending"
                        : sortDirection === "desc"
                          ? "descending"
                          : "none"
                    }
                    className={header.column.columnDef.meta?.className}
                  >
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
              {isDebugEnabled && <TableHead>Debug</TableHead>}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody
          className={
            !isLoading && table.getRowModel().rows?.length
              ? "stagger-children"
              : undefined
          }
        >
          {isLoading ? (
            <TableRow>
              <TableCell
                colSpan={
                  table.getAllColumns().length + (isDebugEnabled ? 1 : 0)
                }
                className="h-16 text-center"
              >
                <div className="flex items-center justify-center gap-2">
                  <Spinner />
                  <span>Loading...</span>
                </div>
              </TableCell>
            </TableRow>
          ) : table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && "selected"}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cell.column.columnDef.meta?.className}
                  >
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
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          <Bug className="h-4 w-4" />
                          <span className="sr-only">Debug row data</span>
                        </Button>
                      }
                    />
                  </TableCell>
                )}
              </TableRow>
            ))
          ) : error ? (
            <TableRow>
              <TableCell
                colSpan={
                  table.getAllColumns().length + (isDebugEnabled ? 1 : 0)
                }
                className="h-16 text-center"
              >
                <ErrorDisplay error={error} />
              </TableCell>
            </TableRow>
          ) : (
            <TableRow>
              <TableCell
                colSpan={
                  table.getAllColumns().length + (isDebugEnabled ? 1 : 0)
                }
                className="h-24"
              >
                <Empty className="border-none py-4">
                  <EmptyTitle>No results</EmptyTitle>
                  <EmptyDescription>
                    Try adjusting your search or filters
                  </EmptyDescription>
                </Empty>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* Mobile Card View */}
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 lg:hidden">
          <Spinner />
          <span>Loading...</span>
        </div>
      ) : error ? (
        <div className="block py-8 lg:hidden">
          <ErrorDisplay error={error} />
        </div>
      ) : (
        <MobileCardView table={table} />
      )}

      <DataTablePagination table={table} />
    </SpacedContainer>
  );
}
