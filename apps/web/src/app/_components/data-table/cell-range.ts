/**
 * Pure, alias-free spreadsheet-style cell selection + range copy/paste logic
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
  | "select"
  | "amount"
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

function clampCoord(
  coord: CellCoord,
  rowCount: number,
  colCount: number,
): CellCoord {
  return {
    row: Math.min(Math.max(coord.row, 0), rowCount - 1),
    col: Math.min(Math.max(coord.col, 0), colCount - 1),
  };
}

const DIRECTION_DELTA: Record<
  "up" | "down" | "left" | "right",
  { row: number; col: number }
> = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
};

/** Arrow-key movement. See module doc for the full contract. */
export function moveFocus(
  sel: CellSelection | null,
  dir: "up" | "down" | "left" | "right",
  extend: boolean,
  rowCount: number,
  colCount: number,
): CellSelection | null {
  if (rowCount <= 0 || colCount <= 0) return null;

  if (!sel) {
    const origin = clampCoord({ row: 0, col: 0 }, rowCount, colCount);
    return { anchor: origin, focus: origin };
  }

  const delta = DIRECTION_DELTA[dir];

  if (!extend) {
    const moved = clampCoord(
      { row: sel.focus.row + delta.row, col: sel.focus.col + delta.col },
      rowCount,
      colCount,
    );
    return { anchor: moved, focus: moved };
  }

  const movedFocus = clampCoord(
    { row: sel.focus.row + delta.row, col: sel.focus.col + delta.col },
    rowCount,
    colCount,
  );
  return { anchor: sel.anchor, focus: movedFocus };
}

/** Clamp both anchor and focus into bounds; null if the table is empty. */
export function clampSelection(
  sel: CellSelection,
  rowCount: number,
  colCount: number,
): CellSelection | null {
  if (rowCount <= 0 || colCount <= 0) return null;
  return {
    anchor: clampCoord(sel.anchor, rowCount, colCount),
    focus: clampCoord(sel.focus, rowCount, colCount),
  };
}

export function cellCount(rect: CellRect): number {
  return (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
}

// --- Copy grid / TSV --------------------------------------------------

export interface CopiedCell {
  kind: CellKind;
  text: string;
  json: unknown;
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

// --- Paste planning ----------------------------------------------------

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
  /** distinct target columns skipped due to kind mismatch or canPaste=false */
  skippedColumnCount: number;
  /** total target cells the plan would touch before skipping (for the cap check) */
  cellTotal: number;
}

export function buildPastePlan(args: {
  grid: CopiedGrid;
  selection: CellRect;
  columns: PasteColumnTarget[];
  rowCount: number;
}): PastePlan {
  const { grid, selection, columns, rowCount } = args;

  const gridRowCount = grid.length;
  const gridColCount = gridRowCount > 0 ? (grid[0]?.length ?? 0) : 0;
  const isFillMode = gridRowCount === 1 && gridColCount === 1;

  const targetTop = selection.top;
  const targetLeft = selection.left;
  const targetBottom = isFillMode
    ? selection.bottom
    : Math.min(selection.top + gridRowCount - 1, rowCount - 1);
  const targetRight = isFillMode
    ? selection.right
    : Math.min(selection.left + gridColCount - 1, columns.length - 1);

  const ops: PasteOp[] = [];
  let cellTotal = 0;
  let skippedColumnCount = 0;

  if (targetBottom < targetTop || targetRight < targetLeft) {
    return { ops, skippedColumnCount, cellTotal };
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
      skippedColumnCount += 1;
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

  return { ops, skippedColumnCount, cellTotal };
}
