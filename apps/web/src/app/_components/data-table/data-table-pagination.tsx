// cf https://ui.shadcn.com/docs/components/data-table#pagination-1

import type { Table } from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { type QueryTiming, QueryTimingIndicator } from "~/lib/query-timing";
import { RowsPerPageSelect } from "./rows-per-page-select";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  timing?: QueryTiming;
}

export function DataTablePagination<TData>({
  table,
  timing,
}: DataTablePaginationProps<TData>) {
  return (
    <div className="flex flex-col space-y-2 px-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
      {/* Selected rows info + timing - hidden on mobile to save space */}
      <div className="hidden items-center gap-2 font-mono text-2xs text-muted-foreground uppercase sm:flex">
        <span>
          {table.getFilteredSelectedRowModel().rows.length} of{" "}
          {table.getFilteredRowModel().rows.length} selected
        </span>
        {timing && <QueryTimingIndicator timing={timing} />}
      </div>

      {/* Main pagination controls */}
      <div className="flex flex-col space-y-2 sm:flex-row sm:items-center sm:space-x-3 sm:space-y-0 lg:space-x-4">
        {/* Rows per page - simplified on mobile */}
        <div className="flex items-center justify-between space-x-2 sm:justify-start">
          <p className="font-medium font-mono text-2xs text-muted-foreground uppercase tracking-wider">
            Rows per page
          </p>
          <RowsPerPageSelect table={table} />
        </div>

        {/* Page info - responsive text */}
        <div className="flex min-w-0 flex-1 items-center justify-center font-mono text-2xs text-muted-foreground uppercase tabular-nums sm:flex-none">
          <span className="hidden sm:inline">
            Page {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount()} ({table.getRowCount()} records)
          </span>
          <span className="sm:hidden">
            {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount()}
          </span>
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center justify-center space-x-1">
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to first page</span>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            className="hidden h-8 w-8 p-0 lg:flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to last page</span>
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
