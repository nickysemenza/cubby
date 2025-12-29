// cf https://ui.shadcn.com/docs/components/data-table
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Bug } from "lucide-react";
import type { ReactNode } from "react";
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
    additionalFilters, // deprecated, fallback
    isLoading = false,
    error,
    ariaLabel = "Data Table",
    timing,
    entity,
    renderMobileCard,
  } = props;

  // Support deprecated additionalFilters prop
  const toolbarContent = additionalToolbarContent ?? additionalFilters;

  const { isDebugEnabled } = useDebug();

  // Dense table styles with warm accents
  const styles = {
    table: "text-[11px] leading-tight",
    header:
      "h-6 px-1.5 py-0.5 border-x border-border/50 text-[10px] font-medium bg-muted/50 text-muted-foreground",
    cell: "px-1.5 py-0.5 min-h-[22px] border-x border-border/30 align-middle",
    row: "even:bg-muted/20 hover:bg-primary/5 hover:border-l-2 hover:border-l-primary/50 transition-colors",
    sortIcon: "h-2.5 w-2.5",
  };

  return (
    <SpacedContainer space={4}>
      <DataTableToolbar table={table} additionalContent={toolbarContent} />

      {/* Desktop Table View */}
      <div className="hidden lg:block">
        <Table aria-label={ariaLabel} className={cn(styles.table)}>
          <TableHeader className="sticky top-0 z-20 bg-background shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className={cn(styles.row)}>
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
                      <ArrowUp className={styles.sortIcon} aria-hidden="true" />
                    ) : (
                      <ArrowUpDown
                        className={styles.sortIcon}
                        aria-hidden="true"
                      />
                    );

                  const filterConfig =
                    header.column.columnDef.meta?.filterConfig;

                  const titleContent = (
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
                      className={cn(
                        header.column.columnDef.meta?.className,
                        styles.header,
                        "align-top",
                      )}
                    >
                      <div className="flex flex-col gap-0.5">
                        {/* Column title with sort */}
                        {canSort ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-4 w-full justify-start px-0.5 text-[10px]"
                            onClick={() =>
                              header.column.toggleSorting(
                                header.column.getIsSorted() === "asc",
                              )
                            }
                          >
                            {titleContent}
                          </Button>
                        ) : (
                          <span className="px-1">{titleContent}</span>
                        )}
                        {/* Inline filter */}
                        {filterConfig && (
                          <HeaderFilter
                            column={header.column}
                            filterConfig={filterConfig}
                          />
                        )}
                      </div>
                    </TableHead>
                  );
                })}
                {/* Add debug header when debug mode is enabled */}
                {isDebugEnabled && (
                  <TableHead className={cn(styles.header)}>Debug</TableHead>
                )}
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
                  <SimpleLoading />
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn(styles.row)}
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

      {/* Mobile Card View */}
      {isLoading ? (
        <div className="lg:hidden">
          <SimpleLoading />
        </div>
      ) : error ? (
        <div className="block py-8 lg:hidden">
          <ErrorDisplay error={error} />
        </div>
      ) : (
        <MobileCardView
          table={table}
          entity={entity}
          renderMobileCard={renderMobileCard}
        />
      )}

      <DataTablePagination table={table} timing={timing} />
    </SpacedContainer>
  );
}
