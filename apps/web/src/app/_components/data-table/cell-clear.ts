import type { CellJsonValue } from "./cell-clipboard";
import type { CellCoord, CellSelection } from "./cell-clipboard-model";
import { selectionRect } from "./cell-clipboard-model";
import type { ColumnCellData } from "./cell-data";

export interface CellClearTarget {
  coord: CellCoord;
  apply: () => Promise<CellJsonValue | null | void>;
}

/** Resolve one nonempty, capability-bearing selected cell into a clear action. */
export function resolveCellClearTarget<TRow>({
  selection,
  rows,
  columnCellData,
}: {
  selection: CellSelection | null;
  rows: readonly TRow[];
  columnCellData: readonly (ColumnCellData<TRow> | null)[];
}): CellClearTarget | null {
  if (!selection) return null;
  const rect = selectionRect(selection);
  if (rect.top !== rect.bottom || rect.left !== rect.right) return null;

  const row = rows[rect.top];
  const cellData = columnCellData[rect.left];
  if (!row || !cellData?.applyClear || cellData.getCopyPayload(row) == null) {
    return null;
  }

  return {
    coord: selection.focus,
    apply: () => cellData.applyClear!(row),
  };
}
