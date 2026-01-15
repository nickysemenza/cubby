// cf https://ui.shadcn.com/docs/components/data-table
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Bug } from "lucide-react";
import { Fragment, type ReactNode, useRef } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { SpacedContainer } from "~/components/layout/spaced-container";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { Entity } from "~/entities/types";
import { useIsMobile } from "~/hooks/use-mobile";
import { useDebug } from "~/hooks/useDebug";
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";
import { DebugDialog } from "./DebugDialog";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableToolbar } from "./data-table-toolbar";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";
import { HeaderFilter } from "./HeaderFilter";
import { MobileCardView } from "./MobileCardView";

// Estimated row height in pixels
const ESTIMATED_ROW_HEIGHT = 35;
// Number of rows to render outside the visible area
const OVERSCAN = 5;
// Max height for the table container (only applied for large datasets)
const MAX_TABLE_HEIGHT = 600;

interface TTableProps<TItem> {
  table: ITable<TItem>;
  /** Slot for additional toolbar content like summaries (e.g., "Value: $5,845.91") */
  additionalToolbarContent?: ReactNode;
  /** Primary actions for the toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
  isLoading?: boolean;
  error?: unknown;
  ariaLabel?: string;
  timing?: QueryTiming;
  /** Entity type for mobile card navigation - when provided, cards become clickable */
  entity?: Entity;
  /**
   * Custom render function for mobile cards.
   * Receives the row and the default card content, allowing full customization.
   * Useful for tables with inline editing or special mobile UX.
   */
  renderMobileCard?: (row: Row<TItem>, defaultContent: ReactNode) => ReactNode;
  /** Callback when a row is clicked */
  onRowClick?: (row: Row<TItem>) => void;
  /** Bulk action bar (rendered in toolbar when rows are selected) */
  bulkActionBar?: ReactNode;
}

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const {
    table,
    additionalToolbarContent,
    actions,
    bulkActionBar,
    isLoading = false,
    error,
    ariaLabel = "Data Table",
    timing,
    entity,
    renderMobileCard,
    onRowClick,
  } = props;

  const { isDebugEnabled } = useDebug();
  const isMobile = useIsMobile();

  // Ref for virtualization scroll container
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const { rows } = table.getRowModel();
  // Always virtualize for consistent rendering
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const styles = {
    table:
      "text-xs leading-tight border-collapse border-spacing-0 [&_tr:nth-child(even)]:bg-[oklch(0.988_0.004_55)]",
    header:
      "h-8 px-2 py-1 text-[11px] font-medium text-foreground/80 bg-muted/30",
    filterRow: "h-7 px-2 py-0.5 bg-muted/30 border-b border-border/50",
    cell: "px-2 py-1 min-h-[28px] align-middle",
    row: "table-row-hover border-b border-border/30",
    sortIcon: "h-3 w-3",
  };

  // Render a single row (used by both virtualized and non-virtualized paths)
  const renderRow = (row: Row<TItem>, style?: React.CSSProperties) => (
    <TableRow
      key={row.id}
      data-state={row.getIsSelected() && "selected"}
      className={cn(styles.row, onRowClick && "cursor-pointer")}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      style={style}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell
          key={cell.id}
          className={cn(styles.cell, cell.column.columnDef.meta?.className)}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
      {/* Add debug cell when debug mode is enabled */}
      {isDebugEnabled && (
        <TableCell className={cn(styles.cell)}>
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
  );

  // Helper to render status rows (loading, error, empty)
  const renderStatusRow = (content: ReactNode, height = "h-16") => (
    <TableRow>
      <TableCell
        colSpan={table.getAllColumns().length + (isDebugEnabled ? 1 : 0)}
        className={cn("text-center", height)}
      >
        {content}
      </TableCell>
    </TableRow>
  );

  // Render table body content based on state
  const renderTableBody = () => {
    if (isLoading) {
      return renderStatusRow(<SimpleLoading />);
    }

    if (error) {
      return renderStatusRow(<ErrorDisplay error={error} />);
    }

    if (!rows.length) {
      const emptyContent = entity ? (
        <EntityEmptyState
          entity={entity}
          isFiltered={hasActiveFilters(table.getState().columnFilters)}
        />
      ) : (
        <EntityEmptyState entity="product" isFiltered={true} />
      );
      return renderStatusRow(emptyContent, "h-24");
    }

    // Always use virtualized rendering for consistent behavior
    return (
      <>
        {/* Top padding row for scroll position */}
        {virtualRows.length > 0 && virtualRows[0].start > 0 && (
          <tr style={{ height: `${virtualRows[0].start}px` }} />
        )}

        {/* Render only visible rows */}
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          return renderRow(row, { height: `${virtualRow.size}px` });
        })}

        {/* Bottom padding row for remaining scroll space */}
        {virtualRows.length > 0 && (
          <tr
            style={{
              height: `${totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0)}px`,
            }}
          />
        )}
      </>
    );
  };

  return (
    <SpacedContainer space={4}>
      {/* Desktop Table View - Unified wrapper */}
      {!isMobile && (
        <div className="overflow-hidden rounded-lg border border-border/50">
          {/* Attached Toolbar */}
          <DataTableToolbar
            table={table}
            additionalContent={additionalToolbarContent}
            actions={actions}
            bulkActionBar={bulkActionBar}
            className="border-border/50 border-b bg-muted/30 px-3 py-2"
          />

          {/* Scrollable container for virtualization */}
          <div
            ref={tableContainerRef}
            className="overflow-auto"
            style={{ maxHeight: `${MAX_TABLE_HEIGHT}px` }}
          >
            <Table
              aria-label={ariaLabel}
              className={cn(styles.table)}
              containerClassName="overflow-visible"
            >
              <TableHeader className="sticky top-0 z-20 bg-background [&_tr]:border-b-0">
                {table.getHeaderGroups().map((headerGroup) => {
                  // Check if any column has a filter config
                  const hasAnyFilters = headerGroup.headers.some(
                    (h) => h.column.columnDef.meta?.filterConfig,
                  );

                  return (
                    <Fragment key={headerGroup.id}>
                      {/* Title Row */}
                      <TableRow
                        className={cn(
                          "border-border/50 border-b-0",
                          !hasAnyFilters && "border-b",
                        )}
                      >
                        {headerGroup.headers.map((header) => {
                          const sortDirection = header.column.getIsSorted();
                          const canSort = header.column.getCanSort();
                          const sortingArrows =
                            sortDirection === "desc" ? (
                              <ArrowDown
                                className={styles.sortIcon}
                                aria-hidden="true"
                              />
                            ) : sortDirection === "asc" ? (
                              <ArrowUp
                                className={styles.sortIcon}
                                aria-hidden="true"
                              />
                            ) : canSort ? (
                              <ArrowUpDown
                                className={cn(
                                  styles.sortIcon,
                                  "opacity-40 group-hover:opacity-100",
                                )}
                                aria-hidden="true"
                              />
                            ) : null;

                          const titleContent = (
                            <>
                              {header.isPlaceholder
                                ? null
                                : flexRender(
                                    header.column.columnDef.header,
                                    header.getContext(),
                                  )}
                              {sortingArrows}
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
                              className={cn(
                                header.column.columnDef.meta?.className,
                                styles.header,
                              )}
                            >
                              {canSort ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="group -ml-2 h-6 justify-start gap-1 px-2 font-medium text-[11px] hover:bg-muted/60"
                                  onClick={() =>
                                    header.column.toggleSorting(
                                      header.column.getIsSorted() === "asc",
                                    )
                                  }
                                >
                                  {titleContent}
                                </Button>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  {titleContent}
                                </span>
                              )}
                            </TableHead>
                          );
                        })}
                        {isDebugEnabled && (
                          <TableHead className={cn(styles.header)}>
                            Debug
                          </TableHead>
                        )}
                      </TableRow>

                      {/* Filter Row - only render if any column has filters */}
                      {hasAnyFilters && (
                        <TableRow
                          key={`${headerGroup.id}-filters`}
                          className={styles.filterRow}
                        >
                          {headerGroup.headers.map((header) => {
                            const filterConfig =
                              header.column.columnDef.meta?.filterConfig;

                            return (
                              <TableHead
                                key={`${header.id}-filter`}
                                colSpan={header.colSpan}
                                className={cn(
                                  header.column.columnDef.meta?.className,
                                  styles.filterRow,
                                )}
                              >
                                {filterConfig && (
                                  <HeaderFilter
                                    column={header.column}
                                    filterConfig={filterConfig}
                                  />
                                )}
                              </TableHead>
                            );
                          })}
                          {isDebugEnabled && (
                            <TableHead className={cn(styles.filterRow)} />
                          )}
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableHeader>
              <TableBody>{renderTableBody()}</TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Mobile Toolbar + Card View */}
      {isMobile && (
        <div>
          <DataTableToolbar
            table={table}
            additionalContent={additionalToolbarContent}
            actions={actions}
            bulkActionBar={bulkActionBar}
            className="mb-3 rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
          />
          {isLoading ? (
            <SimpleLoading />
          ) : error ? (
            <div className="py-8">
              <ErrorDisplay error={error} />
            </div>
          ) : (
            <MobileCardView
              table={table}
              entity={entity}
              renderMobileCard={renderMobileCard}
            />
          )}
        </div>
      )}

      {table.getPageCount() > 1 && (
        <DataTablePagination table={table} timing={timing} />
      )}
    </SpacedContainer>
  );
}
