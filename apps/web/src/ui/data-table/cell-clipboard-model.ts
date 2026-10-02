import type { CellJsonValue } from "./cell-clipboard";

/**
 * Pure, alias-free clipboard and paste-planning model
 * for data tables. No React, no `~/` imports — importable from vitest unit
 * tests per repo convention (see `vitest.config.ts`'s `unit` project).
 *
 * Coordinates are `{ row, col }` indices into the table's visible rows /
 * selectable columns; callers own the mapping to actual `RowData`/column ids.
 */

export type CellKind =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "boolean"
  | "select"
  | "amount"
  | "tags"
  | `entity:${string}`;

export interface CellCoord {
  row: number;
  col: number;
}

export interface CellSelection {
  anchor: CellCoord;
  focus: CellCoord;
}

export interface CellRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Normalized rect (min/max) spanning a selection's anchor and focus. */
export function selectionRect(sel: CellSelection): CellRect {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  };
}

export interface CopiedCell {
  kind: CellKind;
  text: string;
  json: CellJsonValue | undefined;
}

/** rows x cols, rectangular. */
export type CopiedGrid = CopiedCell[][];

/** Replace tab and newline characters with a single space (lossy TSV,
 * matches Google Sheets / Excel copy behavior for embedded whitespace). */
function sanitizeTsvField(text: string): string {
  return text.replace(/\t/g, " ").replace(/\r\n|\r|\n/g, " ");
}

export function gridToTsv(grid: CopiedGrid): string {
  return grid
    .map((row) => row.map((cell) => sanitizeTsvField(cell.text)).join("\t"))
    .join("\n");
}

/** Split TSV text into a rectangular string grid, tolerating `\r\n` and a
 * single trailing newline (from e.g. a copied full row). Ragged rows are
 * padded with `""` to the max row width. */
export function parseTsv(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const rows = lines.map((line) => line.split("\t"));
  const maxWidth = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) => {
    if (row.length >= maxWidth) return row;
    const padded = row.slice();
    while (padded.length < maxWidth) padded.push("");
    return padded;
  });
}

export interface PasteColumnTarget {
  kind: CellKind | null;
  canPaste: boolean;
}

export interface PasteOp {
  row: number;
  col: number;
  source: CopiedCell;
}

export interface PastePlan {
  ops: PasteOp[];
  /** total target cells the plan would touch before skipping (for the cap check) */
  cellTotal: number;
}

const pasteBounds = (
  grid: CopiedGrid,
  selection: CellRect,
  columns: PasteColumnTarget[],
  rowCount: number,
) => {
  const rowCountInGrid = grid.length;
  const columnCountInGrid = rowCountInGrid > 0 ? (grid[0]?.length ?? 0) : 0;
  const fill = rowCountInGrid === 1 && columnCountInGrid === 1;
  return {
    fill,
    top: selection.top,
    left: selection.left,
    bottom: fill
      ? selection.bottom
      : Math.min(selection.top + rowCountInGrid - 1, rowCount - 1),
    right: fill
      ? selection.right
      : Math.min(selection.left + columnCountInGrid - 1, columns.length - 1),
  };
};

export function buildPastePlan(args: {
  grid: CopiedGrid;
  selection: CellRect;
  columns: PasteColumnTarget[];
  rowCount: number;
}): PastePlan {
  const { grid, selection, columns, rowCount } = args;

  const {
    fill: isFillMode,
    top: targetTop,
    left: targetLeft,
    bottom: targetBottom,
    right: targetRight,
  } = pasteBounds(grid, selection, columns, rowCount);

  const ops: PasteOp[] = [];
  let cellTotal = 0;

  if (targetBottom < targetTop || targetRight < targetLeft) {
    return { ops, cellTotal };
  }

  for (let col = targetLeft; col <= targetRight; col++) {
    const target = columns[col];
    const rowsInCol = targetBottom - targetTop + 1;
    cellTotal += rowsInCol;

    // Determine the source kind for this column (fill mode: the single
    // source cell; anchor mode: the grid column aligned under this target
    // column).
    const sourceCol = isFillMode ? 0 : col - targetLeft;
    const sampleSource = grid[0]?.[sourceCol];

    const columnCanPaste =
      target?.canPaste &&
      sampleSource !== undefined &&
      target.kind === sampleSource.kind;

    if (!columnCanPaste) {
      continue;
    }

    for (let row = targetTop; row <= targetBottom; row++) {
      const source = isFillMode
        ? grid[0]?.[0]
        : grid[row - targetTop]?.[sourceCol];
      if (!source) continue;
      ops.push({ row, col, source });
    }
  }

  return { ops, cellTotal };
}
