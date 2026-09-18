import type { EntityRef } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";

import type { CubbyColumnMeta } from "./table-meta";

interface EntityMediaColumn {
  columnDef: { meta?: unknown };
}

interface EntityMediaRow<TItem> {
  original: TItem;
}

/** Collect each visible column's public refs once, at the table boundary. */
export function collectTableEntityMediaRefs<TItem extends RowData>(
  columns: readonly EntityMediaColumn[],
  rows: readonly EntityMediaRow<TItem>[],
): EntityRef[] {
  return columns.flatMap((column) => {
    // SAFETY: every column and row came from the same TanStack table. The
    // metadata adapter erased only that shared row generic at its storage slot.
    const resolveRefs = (column.columnDef.meta as CubbyColumnMeta<TItem>)
      ?.entityRefs;
    return resolveRefs ? rows.flatMap((row) => resolveRefs(row.original)) : [];
  });
}
