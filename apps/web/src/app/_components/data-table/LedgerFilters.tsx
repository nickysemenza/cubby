import type { RowData } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

import { humanize } from "~/entities/filters";

import {
  barFieldFromConfig,
  type FilterBarField,
  filterStateToBarFilters,
} from "./filter-bar-core";
import { FilterBar } from "./FilterBar";
import type { CubbyTable as Table } from "./table-features";
import { useFilterBarDraft } from "./useFilterBarDraft";

function isColumnLabel(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * The table-backed manifest filter bar: fields come from the mounted columns'
 * `meta.filterConfig`, state from TanStack. Everything else lives in
 * `filter-bar-core` / `useFilterBarDraft`, shared with the URL-backed bar.
 */
function getLedgerFields<TData extends RowData>(
  table: Table<TData>,
  optionHints?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FilterBarField[] {
  return table.getAllLeafColumns().flatMap((column) => {
    const config = column.columnDef.meta?.filterConfig;
    if (!config) return [];
    const header = column.columnDef.header;
    const label = isColumnLabel(header) ? header : humanize(column.id);
    return [
      barFieldFromConfig(column.id, label, config, optionHints?.[column.id]),
    ];
  });
}

export function LedgerFilters<TData extends RowData>({
  table,
  optionHints,
}: {
  table: Table<TData>;
  /** Server facet counts by mounted column id then option value. */
  optionHints?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}) {
  // TanStack v9 materializes leaf columns after the first table render. The
  // table/options references stay stable across that boundary, so they cannot
  // by themselves invalidate this memo; include the resolved filter-column
  // signature so an initially empty query strip hydrates as soon as the
  // manifest-bearing leaf columns exist.
  const filterColumnsKey = table
    .getAllLeafColumns()
    .filter((column) => column.columnDef.meta?.filterConfig)
    .map((column) => column.id)
    .join("|");
  const fields = useMemo(
    () => getLedgerFields(table, optionHints),
    // oxlint-disable-next-line react/exhaustive-deps -- filterColumnsKey is the late-materializing TanStack v9 signal described above
    [table, table.options.columns, optionHints, filterColumnsKey],
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
    <FilterBar
      filters={draftFilters}
      fields={fields}
      onChange={handleChange}
      className="min-w-0"
    />
  );
}
