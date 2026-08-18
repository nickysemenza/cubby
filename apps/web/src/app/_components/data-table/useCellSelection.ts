import { useStore } from "@tanstack/react-store";
import type { RowData } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { copyText } from "~/lib/clipboard";
import { getErrorMessage } from "~/lib/error-utils";
import { resolveCellClearTarget } from "./cell-clear";
import { flashElement } from "./cell-clipboard";
import {
  buildPastePlan,
  type CellSelection,
  gridToTsv,
  type PasteColumnTarget,
  parseTsv,
  selectionRect,
} from "./cell-clipboard-model";
import {
  bufferMatches,
  getCopyBuffer,
  setCopyBuffer,
} from "./cell-copy-buffer";
import type { ColumnCellData } from "./cell-data";
import {
  alignExternalGrid,
  buildCopyGrid,
  type PasteSummary,
  runPastePlan,
  summarizePasteResult,
} from "./cell-paste-executor";
import {
  CELL_EDIT_EVENT,
  type CellEditEventDetail,
  NON_SELECTABLE_COLUMN_IDS,
} from "./cell-selection-context";
import type { CubbyTable as ITable, CubbyRow as Row } from "./table-features";

interface UseCellSelectionArgs<TItem extends RowData> {
  /** !isMobile. When false the hook is fully inert (no listeners, null state). */
  enabled: boolean;
  rows: Row<TItem>[];
  table: ITable<TItem>;
  /** Scroll a flat row index into view (wraps flatRowToVirtualIndex + scroll). */
  scrollToFlatRow: (rowIndex: number) => void;
  /** Cmd/Ctrl+Enter — the old "Enter opens the row" behavior. */
  onOpenRow?: (row: Row<TItem>) => void;
}

interface ContainerProps {
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
}

interface UseCellSelectionResult {
  selection: CellSelection | null;
  containerProps: ContainerProps;
}

const EMPTY_CONTAINER_PROPS: ContainerProps = {};

function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * Firefox fallback delay: a keydown-armed paste waits this long for the document
 * `paste` event (Chrome/Safari) to fire and cancel it; if none comes (Firefox
 * doesn't dispatch paste to a non-editable focus) the timer runs the buffer paste.
 */
const FIREFOX_PASTE_FALLBACK_MS = 150;

/** Max cells a single paste may touch (source or target) before it's rejected. */
const PASTE_CELL_CAP = 100;

/** Arrow key → native v9 cell-selection direction. */
const ARROW_DIRECTION: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function emitPasteToast(summary: PasteSummary): void {
  match(summary.variant)
    .with("success", () => toast.success(summary.message))
    .with("warning", () => toast.warning(summary.message))
    .with("error", () => toast.error(summary.message))
    .with("info", () => toast.info(summary.message))
    .exhaustive();
}

/**
 * Cubby's domain behavior layered over v9 cell selection. TanStack owns the
 * durable id corners, focus, drag, Shift extension, and keyboard movement;
 * this hook derives integer rectangles only for typed copy/paste/clear/editing.
 */
export function useCellSelection<TItem extends RowData>({
  enabled,
  rows,
  table,
  scrollToFlatRow,
  onOpenRow,
}: UseCellSelectionArgs<TItem>): UseCellSelectionResult {
  const nativeSelection = useStore(table.atoms.cellSelection!);
  const displayColumns = [
    ...table.getStartVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getEndVisibleLeafColumns(),
  ];
  const columnsSignature = displayColumns
    .map(
      (column) =>
        `${column.id}:${column.columnDef.enableCellSelection !== false}`,
    )
    .join(",")
    .concat(`:${table.options.enableCellSelection !== false}`);
  // columnsSignature (a string) is the observable trigger; keying on it rather
  // than the fresh display-order arrays is intentional and stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature stands in for the column list
  const selectableColumnIds = React.useMemo(
    () =>
      [
        ...table.getStartVisibleLeafColumns(),
        ...table.getCenterVisibleLeafColumns(),
        ...table.getEndVisibleLeafColumns(),
      ]
        .filter(
          (column) =>
            table.options.enableCellSelection !== false &&
            column.columnDef.enableCellSelection !== false &&
            !NON_SELECTABLE_COLUMN_IDS.has(column.id),
        )
        .map((column) => column.id),
    [columnsSignature],
  );
  const colCount = selectableColumnIds.length;
  const rowCount = rows.length;

  // Cubby's clipboard/paste layer still consumes a normalized integer rect.
  // Derive that view from v9's durable row/column-id corners; the ids are the
  // source of truth and remain correct as infinite pages append.
  const selection = React.useMemo<CellSelection | null>(() => {
    const range = nativeSelection.at(-1);
    if (!range) return null;
    const anchor = {
      row: rows.findIndex((row) => row.id === range.anchorRowId),
      col: selectableColumnIds.indexOf(range.anchorColumnId),
    };
    const focus = {
      row: rows.findIndex((row) => row.id === range.focusRowId),
      col: selectableColumnIds.indexOf(range.focusColumnId),
    };
    if (anchor.row < 0 || anchor.col < 0 || focus.row < 0 || focus.col < 0) {
      return null;
    }
    return { anchor, focus };
  }, [nativeSelection, rows, selectableColumnIds]);

  // Live refs for the DOM-delegated handlers (recreated cheaply each render, but
  // the window mouseup handler needs stable access to the latest values).
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;
  const selectableColumnIdsRef = React.useRef(selectableColumnIds);
  selectableColumnIdsRef.current = selectableColumnIds;
  // Live rows ref so the document paste listener + timer (which close over one
  // render) read the current row model without re-installing on every data tick.
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // The scroll container is the clipboard/flash query root. Capture it from
  // both keyboard and pointer interaction so a mouse selection can be pasted
  // immediately, before the user presses any other key.
  const containerElRef = React.useRef<HTMLElement | null>(null);
  const clearPendingRef = React.useRef(false);
  // Firefox paste fallback timer id, shared so the document paste handler can
  // synchronously cancel it (the double-paste guard).
  const fallbackPasteTimerRef = React.useRef<number | null>(null);

  const state = table.state;
  const resetCellSelection = table.resetCellSelection;
  const dataSignature = React.useMemo(
    () =>
      JSON.stringify({
        sorting: state.sorting,
        columnFilters: state.columnFilters,
        pagination: state.pagination,
      }),
    [state.sorting, state.columnFilters, state.pagination],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataSignature is the intended trigger
  React.useEffect(() => {
    resetCellSelection(true);
  }, [dataSignature, resetCellSelection]);

  const layoutSignature = React.useMemo(
    () =>
      JSON.stringify({
        order: state.columnOrder,
        pinning: state.columnPinning,
        visibility: state.columnVisibility,
      }),
    [state.columnOrder, state.columnPinning, state.columnVisibility],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized layout signature is the intentional reset trigger
  React.useEffect(() => {
    resetCellSelection(true);
  }, [layoutSignature, resetCellSelection]);

  // Appends preserve id corners. A replacement/removal clears only when a
  // corner actually disappeared; width and density changes never touch ids.
  React.useEffect(() => {
    if (nativeSelection.length === 0) return;
    const rowIds = new Set(rows.map((row) => row.id));
    const columnIds = new Set(selectableColumnIds);
    const valid = nativeSelection.every(
      (range) =>
        rowIds.has(range.anchorRowId) &&
        rowIds.has(range.focusRowId) &&
        columnIds.has(range.anchorColumnId) &&
        columnIds.has(range.focusColumnId),
    );
    if (!valid) resetCellSelection(true);
  }, [nativeSelection, rows, selectableColumnIds, resetCellSelection]);

  const openEditorAt = React.useCallback(
    (container: HTMLElement, row: number, col: number, seedText?: string) => {
      const colId = selectableColumnIdsRef.current[col];
      if (colId == null) return;
      const selector = `tr[data-cell-row="${row}"] td[data-cell-col="${colId}"] [data-cell-edit-trigger]`;
      const dispatch = (el: HTMLElement) => {
        el.focus();
        el.dispatchEvent(
          new CustomEvent<CellEditEventDetail>(CELL_EDIT_EVENT, {
            detail: { seedText },
          }),
        );
      };
      const found = container.querySelector(selector);
      if (found instanceof HTMLElement) {
        dispatch(found);
        return;
      }
      // Anchor row may be virtualized off-screen — scroll to it, then retry
      // once the virtualizer has painted it. If still absent (non-editable
      // cell), no-op.
      scrollToFlatRow(row);
      requestAnimationFrame(() => {
        const retried = container.querySelector(selector);
        if (retried instanceof HTMLElement) dispatch(retried);
      });
    },
    [scrollToFlatRow],
  );

  // Per-selectable-column cell-data lookup, in the same order as
  // selectableColumnIds (the coord column space). `table` is stable, so this
  // callback is stable and the copy/paste callbacks below don't churn.
  const buildColumnCellData = React.useCallback(
    (): (ColumnCellData<TItem> | null)[] =>
      selectableColumnIdsRef.current.map(
        (colId) => table.getColumn(colId)?.columnDef.meta?.cellData ?? null,
      ),
    [table],
  );

  const flashCoords = React.useCallback(
    (
      container: HTMLElement,
      coords: readonly { row: number; col: number }[],
      kind: "copied" | "pasted",
    ) => {
      const colIds = selectableColumnIdsRef.current;
      for (const { row, col } of coords) {
        const colId = colIds[col];
        if (colId == null) continue;
        const td = container.querySelector(
          `tr[data-cell-row="${row}"] td[data-cell-col="${colId}"]`,
        );
        if (td instanceof HTMLElement) flashElement(td, kind);
      }
    },
    [],
  );

  const doCopy = React.useCallback(
    (container: HTMLElement) => {
      const sel = selectionRef.current;
      if (!sel) return;
      const rect = selectionRect(sel);
      const grid = buildCopyGrid({
        rect,
        rows: rowsRef.current.map((r) => r.original),
        columnCellData: buildColumnCellData(),
      });
      const tsv = gridToTsv(grid);
      setCopyBuffer(grid, tsv);
      // Through `copyText` for its execCommand fallback: range copy is also
      // reachable by keyboard on iOS, where the async clipboard rejects
      // outside a trusted gesture. Still no success toast — the ring flash
      // below is the confirmation.
      void copyText(tsv).then((copied) => {
        if (!copied) toast.error("Couldn't access the clipboard to copy");
      });
      const coords: { row: number; col: number }[] = [];
      for (let r = rect.top; r <= rect.bottom; r++) {
        for (let c = rect.left; c <= rect.right; c++)
          coords.push({ row: r, col: c });
      }
      flashCoords(container, coords, "copied");
    },
    [buildColumnCellData, flashCoords],
  );

  const doPaste = React.useCallback(
    async (container: HTMLElement, clipboardText: string) => {
      const sel = selectionRef.current;
      if (!sel) return;
      const rect = selectionRect(sel);
      const rowsNow = rowsRef.current;
      const columnCellData = buildColumnCellData();

      // Source grid: the typed in-app buffer when the clipboard still matches it
      // (recovers kind/json), else an external TSV aligned to target column kinds.
      // v1 limitation: external-TSV paste is unsupported on Firefox (the keydown
      // fallback only replays the in-app buffer).
      let grid: ReturnType<typeof buildCopyGrid>;
      if (bufferMatches(clipboardText)) {
        const buf = getCopyBuffer();
        if (!buf) return;
        grid = buf.grid;
      } else if (clipboardText.trim() !== "") {
        grid = alignExternalGrid({
          textGrid: parseTsv(clipboardText),
          rect,
          columnKinds: columnCellData.map((cd) => cd?.kind ?? null),
        });
      } else {
        return;
      }

      const columns: PasteColumnTarget[] = columnCellData.map((cd) => ({
        kind: cd?.kind ?? null,
        canPaste: cd?.applyPaste != null,
      }));

      const plan = buildPastePlan({
        grid,
        selection: rect,
        columns,
        rowCount: rowsNow.length,
      });

      if (plan.cellTotal > PASTE_CELL_CAP) {
        toast.error(
          `Paste exceeds the ${PASTE_CELL_CAP}-cell limit (${plan.cellTotal} cells)`,
        );
        return;
      }

      if (plan.ops.length === 0) {
        emitPasteToast(
          summarizePasteResult({
            cellTotal: plan.cellTotal,
            opCount: 0,
            updated: 0,
            unchanged: 0,
            failed: 0,
            errors: [],
          }),
        );
        return;
      }

      const result = await runPastePlan({
        ops: plan.ops,
        rows: rowsNow.map((r) => r.original),
        columnCellData,
        formatError: getErrorMessage,
        concurrency: 5,
      });

      emitPasteToast(
        summarizePasteResult({
          cellTotal: plan.cellTotal,
          opCount: plan.ops.length,
          updated: result.updated,
          unchanged: result.unchanged,
          failed: result.failed,
          errors: result.errors,
        }),
      );

      if (result.updatedOps.length > 0) {
        flashCoords(container, result.updatedOps, "pasted");
      }
    },
    [buildColumnCellData, flashCoords],
  );

  const doClear = React.useCallback(
    (container: HTMLElement): boolean => {
      const target = resolveCellClearTarget({
        selection: selectionRef.current,
        rows: rowsRef.current.map((row) => row.original),
        columnCellData: buildColumnCellData(),
      });
      if (!target) return false;
      // Key repeat must not enqueue duplicate writes/audit entries while the
      // first clear is still settling. It is still a handled key so Backspace
      // never falls through to browser navigation.
      if (clearPendingRef.current) return true;

      clearPendingRef.current = true;
      void target
        .apply()
        .then(() => flashCoords(container, [target.coord], "pasted"))
        .catch((error) => toast.error(getErrorMessage(error)))
        .finally(() => {
          clearPendingRef.current = false;
        });
      return true;
    },
    [buildColumnCellData, flashCoords],
  );

  // Primary paste transport: a document-level listener, live only while a
  // selection exists. Chrome/Safari dispatch `paste` to the focused container.
  React.useEffect(() => {
    if (!enabled || !selection) return;
    const handler = (event: ClipboardEvent) => {
      // Double-paste guard: cancel the Firefox keydown fallback SYNCHRONOUSLY,
      // before anything else, so it can't also fire.
      if (fallbackPasteTimerRef.current !== null) {
        window.clearTimeout(fallbackPasteTimerRef.current);
        fallbackPasteTimerRef.current = null;
      }
      // An open editor (input/textarea/contenteditable) owns paste.
      if (isTypingTarget(document.activeElement)) return;
      const container = containerElRef.current;
      if (!container) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.trim() === "" && !getCopyBuffer()) return;
      // Suppress the legacy single-cell paste listener (defense-in-depth: it also
      // early-returns on event.defaultPrevented).
      event.preventDefault();
      void doPaste(container, text);
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [enabled, selection, doPaste]);

  // Clear a pending fallback timer on unmount.
  React.useEffect(
    () => () => {
      if (fallbackPasteTimerRef.current !== null) {
        window.clearTimeout(fallbackPasteTimerRef.current);
      }
    },
    [],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // The container has focusable children (header filter inputs, cell
      // trigger buttons); key events bubble up here. Never hijack typing in an
      // input/textarea/select/contenteditable (an open editor or a filter).
      if (isTypingTarget(document.activeElement)) return;
      if (rowCount === 0 || colCount === 0) return;

      // Copy/paste. Capture the container so the document paste listener (which
      // has no target) and the flash queries can reach the cells.
      containerElRef.current = e.currentTarget;
      const isMod = e.metaKey || e.ctrlKey;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (doClear(e.currentTarget)) e.preventDefault();
        return;
      }

      if (isMod && (e.key === "c" || e.key === "C")) {
        if (!selectionRef.current) return;
        // preventDefault suppresses the native copy so the legacy document copy
        // listener never fires (no double handling).
        e.preventDefault();
        doCopy(e.currentTarget);
        return;
      }

      if (isMod && (e.key === "v" || e.key === "V")) {
        if (!selectionRef.current) return;
        // Firefox fallback ONLY: don't preventDefault. Chrome/Safari fire a
        // document `paste` event (handled above) which cancels this timer
        // synchronously. If none comes (Firefox skips non-editable focus), the
        // timer replays the typed in-app buffer. External TSV isn't recoverable
        // here, so a buffer-less Firefox paste is a no-op (documented v1 gap).
        const container = e.currentTarget;
        if (fallbackPasteTimerRef.current !== null) {
          window.clearTimeout(fallbackPasteTimerRef.current);
        }
        fallbackPasteTimerRef.current = window.setTimeout(() => {
          fallbackPasteTimerRef.current = null;
          const buf = getCopyBuffer();
          if (!buf) return;
          void doPaste(container, buf.tsv);
        }, FIREFOX_PASTE_FALLBACK_MS);
        return;
      }

      const dir = ARROW_DIRECTION[e.key] ?? null;

      if (dir && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!selectionRef.current) {
          const firstRow = rows[0];
          const firstColumnId = selectableColumnIdsRef.current[0];
          if (firstRow && firstColumnId) {
            table.setFocusedCell(firstRow.id, firstColumnId);
          }
        } else if (e.shiftKey) {
          table.extendCellSelection(dir);
        } else {
          table.moveCellSelection(dir);
        }
        const focused = table.getFocusedCell();
        if (focused) {
          const nextRow = rows.findIndex((row) => row.id === focused.row.id);
          if (nextRow >= 0) scrollToFlatRow(nextRow);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const sel = selectionRef.current;
        if (!sel) return;
        if (e.metaKey || e.ctrlKey) {
          // Old Enter behavior: open the anchor row (detail/preview).
          const row = rows[sel.anchor.row];
          if (row) onOpenRow?.(row);
          return;
        }
        openEditorAt(e.currentTarget, sel.anchor.row, sel.anchor.col);
        return;
      }

      if (e.key === "Escape") {
        if (selectionRef.current) {
          e.preventDefault();
          table.resetCellSelection(true);
        }
        return;
      }

      // Type-to-edit: a printable character with a cell selected opens the
      // anchor cell's editor seeded with that character (Google Sheets). Placed
      // last so every shortcut above (mod+C/V, arrows, Enter, Escape) wins.
      // `key.length === 1` matches a single printable char (letters, digits,
      // punctuation, space) and excludes named keys (Tab, Backspace, F-keys).
      // Shift/Alt are allowed — they produce printable characters.
      const sel = selectionRef.current;
      if (sel && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openEditorAt(e.currentTarget, sel.anchor.row, sel.anchor.col, e.key);
        return;
      }
    },
    [
      rowCount,
      colCount,
      rows,
      scrollToFlatRow,
      onOpenRow,
      openEditorAt,
      doCopy,
      doPaste,
      doClear,
      table,
    ],
  );

  const containerProps = React.useMemo<ContainerProps>(() => {
    if (!enabled) return EMPTY_CONTAINER_PROPS;
    return {
      onKeyDown,
      onMouseDown: (event) => {
        containerElRef.current = event.currentTarget;
      },
    };
  }, [enabled, onKeyDown]);

  return {
    selection: enabled ? selection : null,
    containerProps,
  };
}
