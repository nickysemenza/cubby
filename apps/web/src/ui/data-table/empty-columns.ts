import type { RowData } from "@tanstack/react-table";

import { isLockedColumn } from "./column-layout";
import type { CubbyRow, CubbyTable } from "./table-features";

function isEmptyValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Columns with no value in any loaded row. They collapse to a glyph strip so
 * a sparse roster stops spending width on blank cells. A column the person
 * sized, sorted, filtered or pinned stays as they set it.
 */
export function emptyColumnIds<TData extends RowData>(
  table: CubbyTable<TData>,
  rows: readonly CubbyRow<TData>[],
): ReadonlySet<string> {
  const empty = new Set<string>();
  if (rows.length === 0) return empty;
  const sized = table.state.columnSizing ?? {};
  for (const column of table.getVisibleLeafColumns()) {
    if (
      !column.accessorFn ||
      isLockedColumn(column) ||
      column.columnDef.meta?.entityColumnRole === "identity" ||
      column.getIsPinned() ||
      column.getIsSorted() ||
      column.getIsFiltered() ||
      sized[column.id] !== undefined
    )
      continue;
    if (rows.every((row) => isEmptyValue(row.getValue(column.id))))
      empty.add(column.id);
  }
  return empty;
}
