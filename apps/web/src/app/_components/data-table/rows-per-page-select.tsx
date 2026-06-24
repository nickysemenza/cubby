import type { Table } from "@tanstack/react-table";
import { FilterableCombobox } from "~/components/ui/combobox";
import { cn } from "~/lib/utils";

/** Page-size options offered across the data-table chrome. */
const PAGE_SIZES = [10, 50, 100, 1000];

/**
 * Compact rows-per-page selector. Shared by the sticky toolbar (top) and the
 * sticky pagination bar (bottom) so page-size has a single source of truth.
 */
export function RowsPerPageSelect<TData>({
  table,
  className,
}: {
  table: Table<TData>;
  className?: string;
}) {
  return (
    <FilterableCombobox
      items={PAGE_SIZES.map((pageSize) => ({
        value: `${pageSize}`,
        label: `${pageSize}`,
      }))}
      value={`${table.getState().pagination.pageSize}`}
      onValueChange={(value) => {
        if (value) table.setPageSize(Number(value));
      }}
      className={cn("h-8 w-20", className)}
    />
  );
}
