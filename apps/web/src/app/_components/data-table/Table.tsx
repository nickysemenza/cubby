// cf https://ui.shadcn.com/docs/components/data-table
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Bug } from "lucide-react";
import { Fragment, type ReactNode } from "react";
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
import { useDebug } from "~/hooks/useDebug";
import type { QueryTiming } from "~/lib/query-timing";
import { cn } from "~/lib/utils";
import { DebugDialog } from "./DebugDialog";
import { DataTablePagination } from "./data-table-pagination";
import { DataTableToolbar } from "./data-table-toolbar";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";
import { HeaderFilter } from "./HeaderFilter";
import { MobileCardView } from "./MobileCardView";

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
  // Deprecated props - kept for backward compatibility during migration
  /** @deprecated Use column meta.filterConfig instead */
  filterableColumns?: unknown[];
  /** @deprecated Use additionalToolbarContent instead */
  additionalFilters?: ReactNode;
}

export default function RTable<TItem>(props: TTableProps<TItem>) {
  const {
    table,
    additionalToolbarContent,
    actions,
    additionalFilters, // deprecated, fallback
    isLoading = false,
    error,
    ariaLabel = "Data Table",
    timing,
    entity,
    renderMobileCard,
    onRowClick,
  } = props;

  // Support deprecated additionalFilters prop
  const toolbarContent = additionalToolbarContent ?? additionalFilters;

  const { isDebugEnabled } = useDebug();

  // Clean table styles with warm accents
  const styles = {
    table: "text-xs leading-tight",
    header: "h-8 px-2 py-1 text-[11px] font-medium text-foreground/80",
    filterRow: "h-7 px-2 py-0.5 bg-muted/40 border-b border-border/50",
    cell: "px-2 py-1 min-h-[28px] align-middle",
    row: "even:bg-muted/20 hover:bg-primary/5 hover:border-l-2 hover:border-l-primary/50 transition-colors border-b border-border/30",
    sortIcon: "h-3 w-3",
  };

  return (
    <SpacedContainer space={4}>
      {/* Desktop Table View - Unified wrapper */}
      <div className="hidden overflow-hidden rounded-lg border border-border/50 lg:block">
        {/* Attached Toolbar */}
        <DataTableToolbar
          table={table}
          additionalContent={toolbarContent}
          actions={actions}
          className="border-border/50 border-b bg-muted/30 px-3 py-2"
        />

        <Table aria-label={ariaLabel} className={cn(styles.table)}>
          <TableHeader className="sticky top-0 z-20 bg-background">
            {table.getHeaderGroups().map((headerGroup) => {
              // Check if any column has a filter config
              const hasAnyFilters = headerGroup.headers.some(
                (h) => h.column.columnDef.meta?.filterConfig,
              );

              return (
                <Fragment key={headerGroup.id}>
                  {/* Title Row */}
                  <TableRow className="border-border/50 border-b">
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
                      <TableHead className={cn(styles.header)}>Debug</TableHead>
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
                  <SimpleLoading />
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn(styles.row, onRowClick && "cursor-pointer")}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        styles.cell,
                        cell.column.columnDef.meta?.className,
                      )}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                  {/* Add debug cell when debug mode is enabled */}
                  {isDebugEnabled && (
                    <TableCell className={cn(styles.cell)}>
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
                  {entity ? (
                    <EntityEmptyState
                      entity={entity}
                      isFiltered={hasActiveFilters(
                        table.getState().columnFilters,
                      )}
                    />
                  ) : (
                    <EntityEmptyState entity="product" isFiltered={true} />
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile Toolbar + Card View */}
      <div className="lg:hidden">
        <DataTableToolbar
          table={table}
          additionalContent={toolbarContent}
          actions={actions}
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

      <DataTablePagination table={table} timing={timing} />
    </SpacedContainer>
  );
}
