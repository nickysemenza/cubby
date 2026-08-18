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
import { formatCurrency } from "~/lib/utils";
import { getCellSelectionStats } from "./cell-selection-stats";
import { RowsPerPageSelect } from "./rows-per-page-select";
import type { CubbyTable as Table } from "./table-features";

interface DataTablePaginationProps<TData extends RowData> {
  table: Table<TData>;
  timing?: QueryTiming;
  /** Keep the pager chrome for normal tables; infinite lists only need status. */
  showPaginationControls?: boolean;
  /** Opt-in: only the Expenses ledger exposes spreadsheet selection totals. */
  showCellSelectionStats?: boolean;
}

export function DataTablePagination<TData extends RowData>({
  table,
  timing,
  showPaginationControls = true,
  showCellSelectionStats = false,
}: DataTablePaginationProps<TData>) {
  return (
    <div className="flex flex-col space-y-1 px-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
      {/* Selected rows info + timing - hidden on mobile to save space */}
      <div className="hidden items-center gap-2 font-mono text-2xs text-muted-foreground uppercase sm:flex">
        <table.Subscribe source={table.atoms.rowSelection!}>
          {() => (
            <>
              <span>
                {table.getFilteredSelectedRowModel().rows.length} of{" "}
                {table.getFilteredRowModel().rows.length} selected
              </span>
              {showCellSelectionStats && (
                <table.Subscribe source={table.atoms.cellSelection!}>
                  {() => {
                    const stats = getCellSelectionStats(table);
                    if (!stats) return null;
                    const number = new Intl.NumberFormat(undefined, {
                      maximumFractionDigits: 2,
                    });
                    const format = (value: number) =>
                      stats.kind === "currency"
                        ? formatCurrency(value)
                        : number.format(value);
                    return (
                      <span data-selection-stats>
                        Cells: {stats.cellCount}
                        {stats.sum !== null && stats.average !== null
                          ? ` · ${stats.numericCount} values · Sum ${format(stats.sum)} · Avg ${format(stats.average)}`
                          : ""}
                      </span>
                    );
                  }}
                </table.Subscribe>
              )}
              {timing && <QueryTimingIndicator timing={timing} />}
            </>
          )}
        </table.Subscribe>
      </div>

      {/* Main pagination controls */}
      {showPaginationControls && (
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
      )}
    </div>
  );
}
