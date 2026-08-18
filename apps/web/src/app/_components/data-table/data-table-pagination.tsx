// cf https://ui.shadcn.com/docs/components/data-table#pagination-1

import type { RowData } from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { type QueryTiming, QueryTimingIndicator } from "~/lib/query-timing";
import { RowsPerPageSelect } from "./rows-per-page-select";
import type { CubbyTable as Table } from "./table-features";

interface DataTablePaginationProps<TData extends RowData> {
  table: Table<TData>;
  timing?: QueryTiming;
}

export function DataTablePagination<TData extends RowData>({
  table,
  timing,
}: DataTablePaginationProps<TData>) {
  return (
    <div className="flex flex-col space-y-1 px-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
      {/* Selected rows info + timing - hidden on mobile to save space */}
      <div className="hidden items-center gap-2 font-mono text-2xs text-muted-foreground uppercase sm:flex">
        <span>
          {table.getFilteredSelectedRowModel().rows.length} of{" "}
          {table.getFilteredRowModel().rows.length} selected
        </span>
        {timing && <QueryTimingIndicator timing={timing} />}
      </div>

      {/* Main pagination controls */}
      <div className="flex flex-col space-y-1 sm:flex-row sm:items-center sm:space-x-4 sm:space-y-0 lg:space-x-4">
        {/* Rows per page - simplified on mobile */}
        <Row
          align="center"
          justify="between"
          gap="sm"
          className="sm:justify-start"
        >
          <p className="font-medium font-mono text-2xs text-muted-foreground uppercase tracking-wider">
            Rows per page
          </p>
          <RowsPerPageSelect table={table} />
        </Row>

        {/* Page info - responsive text */}
        <Row
          align="center"
          justify="center"
          className="min-w-0 flex-1 font-mono text-2xs text-muted-foreground uppercase tabular-nums sm:flex-none"
        >
          <span className="hidden sm:inline">
            Page {table.state.pagination.pageIndex + 1} of{" "}
            {table.getPageCount()} ({table.getRowCount()} records)
          </span>
          <span className="sm:hidden">
            {table.state.pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
        </Row>

        {/* Navigation buttons */}
        <Row align="center" justify="center" gap="xs">
          <Button
            variant="outline"
            size="icon"
            className="hidden lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to first page</span>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="hidden lg:flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">Go to last page</span>
            <ChevronsRight />
          </Button>
        </Row>
      </div>
    </div>
  );
}
