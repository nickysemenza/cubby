import type { RowData } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";
import { Filters } from "~/components/reui/filters";
import { humanize } from "~/entities/filters";
import type { FilterConfig } from "./columnHelpers";
import {
  barFieldFromConfig,
  type FilterBarField,
  filterStateToBarFilters,
} from "./filter-bar-core";
import type { CubbyTable as Table } from "./table-features";
import { useFilterBarDraft } from "./useFilterBarDraft";

/**
 * The table-backed manifest filter bar: fields come from the mounted columns'
 * `meta.filterConfig`, state from TanStack. Everything else lives in
 * `filter-bar-core` / `useFilterBarDraft`, shared with the URL-backed bar.
 */
function getLedgerFields<TData extends RowData>(
  table: Table<TData>,
): FilterBarField[] {
  return table.getAllLeafColumns().flatMap((column) => {
    const config = column.columnDef.meta?.filterConfig as
      | FilterConfig
      | undefined;
    if (!config) return [];
    const header = column.columnDef.header;
    const label = typeof header === "string" ? header : humanize(column.id);
    return [barFieldFromConfig(column.id, label, config)];
  });
}

export function LedgerFilters<TData extends RowData>({
  table,
}: {
  table: Table<TData>;
}) {
  const fields = useMemo(
    () => getLedgerFields(table),
    [table, table.options.columns],
  );
  const externalColumnFilters = table.state.columnFilters;
  const externalFilters = useMemo(
    () => filterStateToBarFilters(externalColumnFilters, fields),
    [externalColumnFilters, fields],
  );
  const commit = useCallback(
    (next: Parameters<typeof table.setColumnFilters>[0]) =>
      table.setColumnFilters(next),
    [table],
  );
  const { draftFilters, handleChange } = useFilterBarDraft({
    externalFilters,
    fields,
    commit,
  });

  if (fields.length === 0) return null;

  return (
    <Filters
      filters={draftFilters}
      fields={fields}
      onChange={handleChange}
      allowMultiple={false}
      collapseAddButton
      showSearchInput
      size="sm"
      variant="solid"
      className="min-w-0"
    />
  );
}
