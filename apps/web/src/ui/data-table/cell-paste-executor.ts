/**
 * Pure, alias-free execution helpers for the range copy/paste engine. No React,
 * no `~/` imports (only type-only imports from sibling pure modules, which are
 * erased) — importable from vitest unit tests per repo convention.
 *
 * The hook (`useCellSelection.ts`) owns the DOM/clipboard transport and supplies
 * row objects + per-column `ColumnCellData` lookups; these functions do the pure
 * work: building a copy grid, aligning an external TSV paste to target column
 * kinds, the unchanged-skip comparison, the bounded-concurrency plan run, and
 * the summary message. Keeping them here makes the tricky bits unit-testable.
 */

import type { getErrorMessage } from "@cubby/shared";
import pMap from "p-map";

import type { CellJsonValue } from "./cell-clipboard";
import type {
  CellKind,
  CellRect,
  CopiedCell,
  CopiedGrid,
  PasteOp,
} from "./cell-clipboard-model";
import type { ColumnCellData } from "./cell-data";

/**
 * Build a rectangular `CopiedGrid` from the TanStack row model. `rows` is
 * indexed by flat row index, `columnCellData` by selectable-column index — both
 * the same coordinate space the selection rect uses.
 *
 * A cell whose column has `cellData` keeps that column's kind even when the row
 * has nothing to copy (null payload → empty text, null json). A column without
 * `cellData` contributes a plain empty text cell.
 */
export function buildCopyGrid<TRow>(params: {
  rect: CellRect;
  rows: readonly TRow[];
  columnCellData: readonly (ColumnCellData<TRow> | null)[];
}): CopiedGrid {
  const { rect, rows, columnCellData } = params;
  const grid: CopiedGrid = [];
  for (let r = rect.top; r <= rect.bottom; r++) {
    const row = rows[r];
    const gridRow: CopiedCell[] = [];
    for (let c = rect.left; c <= rect.right; c++) {
      const cellData = columnCellData[c] ?? null;
      if (!cellData) {
        gridRow.push({ kind: "text", text: "", json: null });
        continue;
      }
      const payload = row === undefined ? null : cellData.getCopyPayload(row);
      gridRow.push({
        kind: cellData.kind,
        text: payload?.text ?? "",
        json: payload?.json ?? null,
      });
    }
    grid.push(gridRow);
  }
  return grid;
}

/**
 * Align an external (out-of-app) TSV paste to the target columns' kinds. Each
 * source cell adopts the kind of the target column it will land on, so
 * `buildPastePlan`'s per-column kind check matches trivially and each column's
 * `applyPaste` does the real text validation. `json` is left `undefined` — the
 * text-only path.
 *
 * For a 1×1 source (fill mode) the single cell adopts the anchor (top-left)
 * column's kind, so a scalar fill only lands on same-kind columns.
 */
export function alignExternalGrid(params: {
  textGrid: readonly (readonly string[])[];
  rect: CellRect;
  columnKinds: readonly (CellKind | null)[];
}): CopiedGrid {
  const { textGrid, rect, columnKinds } = params;
  return textGrid.map((textRow) =>
    textRow.map((text, j) => {
      const targetCol = rect.left + j;
      const kind: CellKind = columnKinds[targetCol] ?? "text";
      return { kind, text, json: undefined };
    }),
  );
}

/**
 * Whether a paste op would be a no-op. Typed source (json defined) → deep-equal
 * compare of the source vs the cell's current json (skip identical writes). A
 * text-only source (json undefined) is always attempted — the target's
 * `applyPaste` parses and validates the text.
 */
export function isOpUnchanged(
  source: CopiedCell,
  currentJson: CellJsonValue,
): boolean {
  if (source.json === undefined) return false;
  return JSON.stringify(source.json) === JSON.stringify(currentJson);
}

export interface PasteRunResult {
  /** Ops that saved successfully — used to flash the target cells. */
  updatedOps: PasteOp[];
  updated: number;
  /** Dropped as identical to the current value (silent). */
  unchanged: number;
  failed: number;
  /** One message per failed op (via the injected `formatError`). */
  errors: string[];
}

/**
 * Run a paste plan's ops: drop unchanged writes, then execute the rest with
 * bounded concurrency, capturing per-op errors (never rejecting the batch).
 * Pure boundary — `formatError` (the hook passes `getErrorMessage`) keeps this
 * alias-free.
 */
export async function runPastePlan<TRow>(params: {
  ops: readonly PasteOp[];
  rows: readonly TRow[];
  columnCellData: readonly (ColumnCellData<TRow> | null)[];
  formatError: typeof getErrorMessage;
  concurrency?: number;
}): Promise<PasteRunResult> {
  const { ops, rows, columnCellData, formatError, concurrency = 5 } = params;
  const updatedOps: PasteOp[] = [];
  const errors: string[] = [];
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  const attempts: PasteOp[] = [];
  for (const op of ops) {
    const cellData = columnCellData[op.col] ?? null;
    const row = rows[op.row];
    if (!cellData?.applyPaste || row === undefined) continue;
    const currentJson = cellData.getCopyPayload(row)?.json ?? null;
    if (isOpUnchanged(op.source, currentJson)) {
      unchanged++;
      continue;
    }
    attempts.push(op);
  }

  // The worker never rejects (per-op try/catch), so pMap never short-circuits.
  await pMap(
    attempts,
    async (op) => {
      const cellData = columnCellData[op.col] ?? null;
      const row = rows[op.row];
      if (!cellData?.applyPaste || row === undefined) return;
      try {
        await cellData.applyPaste(row, {
          json: op.source.json,
          text: op.source.text,
        });
        updated++;
        updatedOps.push(op);
      } catch (err) {
        failed++;
        errors.push(formatError(err));
      }
    },
    { concurrency: Math.max(concurrency, 1) },
  );

  return { updatedOps, updated, unchanged, failed, errors };
}

type PasteToastVariant = "success" | "warning" | "error" | "info";

export interface PasteSummary {
  variant: PasteToastVariant;
  message: string;
}

/**
 * Build the single summary toast for a completed paste. `opCount` is
 * `plan.ops.length` (cells in pasteable columns); `cellTotal` includes cells in
 * columns skipped for a kind mismatch / read-only column, so the "skipped
 * (type)" count is `cellTotal − opCount`.
 */
export function summarizePasteResult(params: {
  cellTotal: number;
  opCount: number;
  updated: number;
  unchanged: number;
  failed: number;
  errors: readonly string[];
}): PasteSummary {
  const { cellTotal, opCount, updated, failed, errors } = params;
  const skippedCells = Math.max(cellTotal - opCount, 0);

  if (updated === 0 && failed === 0) {
    return {
      variant: "info",
      message:
        opCount === 0
          ? "Nothing to paste here (column types don't match)"
          : "Nothing to paste — values already match",
    };
  }

  if (failed === 0 && skippedCells === 0) {
    return {
      variant: "success",
      message: `${updated} cell${updated === 1 ? "" : "s"} updated`,
    };
  }

  const parts = [`${updated} updated`];
  if (skippedCells > 0) parts.push(`${skippedCells} skipped (type)`);
  if (failed > 0) parts.push(`${failed} failed`);
  let message = parts.join(" · ");
  if (failed > 0 && errors.length > 0) {
    const first = errors[0];
    if (first !== undefined && errors.every((e) => e === first)) {
      message += `: ${first}`;
    }
  }

  return { variant: failed > 0 ? "error" : "warning", message };
}
