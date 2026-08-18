import type { RowData } from "@tanstack/react-table";
import type { CubbyTable } from "./table-features";

export interface CellSelectionStats {
  /** Every selected, selectable cell, including empty values. */
  cellCount: number;
  /** Finite numeric values included in the sum/average. */
  numericCount: number;
  kind: "number" | "currency" | null;
  sum: number | null;
  average: number | null;
}

/**
 * Computes display-only selection statistics from typed cell metadata.
 *
 * A selection spanning text, dates, entities, or mixed number/currency kinds
 * deliberately exposes counts only. That is preferable to implying that a
 * dollar amount and a scalar quantity can be added meaningfully.
 */
export function getCellSelectionStats<TData extends RowData>(
  table: CubbyTable<TData>,
): CellSelectionStats | null {
  const rows = table.getRowModel().rows;
  const columns = [
    ...table.getStartVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getEndVisibleLeafColumns(),
  ].filter(
    (column) =>
      table.options.enableCellSelection !== false &&
      column.columnDef.enableCellSelection !== false,
  );

  let cellCount = 0;
  let numericCount = 0;
  let sum = 0;
  let kind: "number" | "currency" | null = null;
  let mixedOrNonNumeric = false;

  for (const row of rows) {
    for (const column of columns) {
      const cell = row
        .getAllCells()
        .find((candidate) => candidate.column.id === column.id);
      if (!cell?.getIsSelected()) continue;
      cellCount += 1;

      const data = column.columnDef.meta?.cellData;
      if (
        !data?.getNumericValue ||
        (data.kind !== "number" && data.kind !== "currency")
      ) {
        mixedOrNonNumeric = true;
        continue;
      }

      if (kind && kind !== data.kind) {
        mixedOrNonNumeric = true;
        continue;
      }
      kind = data.kind;
      const value = data.getNumericValue(row.original);
      if (value == null || !Number.isFinite(value)) continue;
      numericCount += 1;
      sum += value;
    }
  }

  if (cellCount === 0) return null;
  if (mixedOrNonNumeric || kind == null) {
    return { cellCount, numericCount, kind: null, sum: null, average: null };
  }
  return {
    cellCount,
    numericCount,
    kind,
    sum,
    average: numericCount > 0 ? sum / numericCount : null,
  };
}
