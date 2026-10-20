import type { RowData } from "@tanstack/react-table";

import type { CubbyColumn, CubbyRow } from "../table-features";
import { mobileColumnLabel } from "../table-meta";

/** Currency projections already loaded by the table; never parse formatted text. */
export function tableMoneyTotals<TData extends RowData>(
  columns: CubbyColumn<TData, unknown>[],
  rows: CubbyRow<TData>[],
) {
  return columns.flatMap((column) => {
    const meta = column.columnDef.meta;
    if (meta?.valueKind !== "money" && meta?.cellData?.kind !== "currency")
      return [];
    const values = rows.flatMap((row) => {
      // Progressive lists must not invoke accessors before their projection
      // is ready (for example, Product pricing arrives after its identity).
      if (row.original == null || meta.valueUnavailable?.(row.original))
        return [];
      const value = meta.cellData?.getNumericValue
        ? meta.cellData.getNumericValue(row.original)
        : row.getValue(column.id);
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    });
    return values.length
      ? [
          {
            columnId: column.id,
            label: mobileColumnLabel(column),
            value: values.reduce((sum, value) => sum + value, 0),
          },
        ]
      : [];
  });
}
