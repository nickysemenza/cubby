import type { Table } from "@tanstack/react-table";
import { FilterableCombobox } from "~/components/ui/combobox";
import { cn } from "~/lib/utils";

/** Page-size options offered across the data-table chrome. */
const PAGE_SIZES = [25, 50, 100, 250, 500];

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
  // Several tables set a bespoke page size (a detail-page section's 10, a
  // recipe's ingredient count). The combobox renders its *matching item's*
  // label, so an off-scale size with no item shows a blank box — fold the
  // current size into the options so the control always reads its real value.
  const current = table.getState().pagination.pageSize;
  const sizes = PAGE_SIZES.includes(current)
    ? PAGE_SIZES
    : [...PAGE_SIZES, current].sort((a, b) => a - b);

  return (
    <FilterableCombobox
      items={sizes.map((pageSize) => ({
        value: `${pageSize}`,
        label: `${pageSize}`,
      }))}
      value={`${current}`}
      onValueChange={(value) => {
        if (value) table.setPageSize(Number(value));
      }}
      className={cn("h-7 w-20", className)}
    />
  );
}
