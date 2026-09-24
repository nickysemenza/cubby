import { CaretDoubleLeftIcon } from "@phosphor-icons/react/dist/csr/CaretDoubleLeft";
import { CaretDoubleRightIcon } from "@phosphor-icons/react/dist/csr/CaretDoubleRight";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { RowData } from "@tanstack/react-table";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { type QueryTiming, QueryTimingIndicator } from "~/lib/query-timing";
import { formatCount, formatCurrency } from "~/lib/utils";

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
  /** Embedded ledgers retain navigation without owning the page-size choice. */
  variant?: "page" | "embedded";
}

export function DataTablePagination<TData extends RowData>({
  table,
  timing,
  showPaginationControls = true,
  showCellSelectionStats = false,
  variant = "page",
}: DataTablePaginationProps<TData>) {
  const embedded = variant === "embedded";
  return (
    <div
      data-pagination-variant={variant}
      className={
        embedded
          ? "flex items-center justify-between gap-2 px-2"
          : "flex flex-col space-y-1 px-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0"
      }
    >
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
                    const format = (value: number) =>
                      stats.kind === "currency"
                        ? formatCurrency(value)
                        : formatCount(value, 2);
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

      {showPaginationControls && (
        <div
          className={
            embedded
              ? "flex items-center gap-2 sm:gap-4"
              : "flex flex-col space-y-1 sm:flex-row sm:items-center sm:space-y-0 sm:space-x-4 lg:space-x-4"
          }
        >
          {!embedded && (
            <Row
              align="center"
              justify="between"
              gap="sm"
              className="sm:justify-start"
            >
              <p className="font-mono text-2xs font-medium tracking-wider text-muted-foreground uppercase">
                Rows per page
              </p>
              <RowsPerPageSelect table={table} />
            </Row>
          )}

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

          <Row align="center" justify="center" gap="xs">
            <Button
              variant="outline"
              size="icon"
              className="hidden lg:flex"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to first page</span>
              <CaretDoubleLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to previous page</span>
              <CaretLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Go to next page</span>
              <CaretRightIcon />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="hidden lg:flex"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Go to last page</span>
              <CaretDoubleRightIcon />
            </Button>
          </Row>
        </div>
      )}
    </div>
  );
}
