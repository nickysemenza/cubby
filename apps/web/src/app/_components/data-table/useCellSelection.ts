import type { Table as ITable, Row } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { getErrorMessage } from "~/lib/error-utils";
import { flashElement } from "./cell-clipboard";
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
  buildPastePlan,
  type CellCoord,
  type CellSelection,
  clampSelection,
  gridToTsv,
  moveFocus,
  type PasteColumnTarget,
  parseTsv,
  selectionRect,
} from "./cell-range";
import {
  CELL_EDIT_EVENT,
  type CellEditEventDetail,
  NON_SELECTABLE_COLUMN_IDS,
} from "./cell-selection-context";

/**
 * Per-row projection of the current selection, handed to each `DesktopDataRow`.
 * Rows outside the selection rect get `undefined` (memo-stable); rows inside
 * share one `colsKey`, and only the anchor row carries a non-null `anchorColId`.
 */
export interface RowCellSelection {
  /** Comma-joined selected column ids (identical for every row in the rect). */
  colsKey: string;
  /** The anchor column id — non-null only on the anchor row. */
  anchorColId: string | null;
}

interface UseCellSelectionArgs<TItem> {
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
  onMouseOver?: React.MouseEventHandler<HTMLDivElement>;
  /** Present while dragging so the container can `select-none` (kills the
   * native text selection a drag would otherwise paint across cells). */
  "data-cell-dragging"?: string;
}

interface UseCellSelectionResult {
  selection: CellSelection | null;
  getRowCellSelection: (rowIndex: number) => RowCellSelection | undefined;
  containerProps: ContainerProps;
}

const EMPTY_CONTAINER_PROPS: ContainerProps = {};

// Environment-stable: the choice never changes within a runtime, so the same
// hook is called every render. Avoids React's "useLayoutEffect does nothing on
// the server" warning (RTable renders during SSR).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

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

/** Arrow key → movement direction (mirrors DIRECTION_DELTA's style in cell-range.ts). */
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
 * Spreadsheet-style cell selection for the desktop RTable: index-based
 * `{anchor, focus}` over the flat visible row model × selectable columns, with
 * keyboard (arrows/shift-arrows/Enter/Escape) and mouse (click, shift-click,
 * drag) driving it. Copy/paste EXECUTION is a later phase — this hook only owns
 * the selection state + input; it deliberately does NOT intercept Cmd/Ctrl+C/V.
 */
export function useCellSelection<TItem>({
  enabled,
  rows,
  table,
  scrollToFlatRow,
  onOpenRow,
}: UseCellSelectionArgs<TItem>): UseCellSelectionResult {
  const [selection, setSelection] = React.useState<CellSelection | null>(null);
  const [dragging, setDragging] = React.useState(false);
  // Ref mirror so the window-level mouseup listener (which closes over one
  // render) reads live drag state; and so unmount cleanup can detach it.
  const draggingRef = React.useRef(false);
  const windowMouseUpRef = React.useRef<(() => void) | null>(null);

  // Selectable columns, in render order — the col-index space for coords. The
  // signature captures visible-column changes (toggle/reorder) so this recomputes.
  const columnsSignature = table
    .getVisibleLeafColumns()
    .map((c) => c.id)
    .join(",");
  // columnsSignature (a string) is the observable trigger; keying on it rather
  // than the table.getVisibleLeafColumns() array is intentional and stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature stands in for the column list
  const selectableColumnIds = React.useMemo(
    () =>
      table
        .getVisibleLeafColumns()
        .filter((c) => !NON_SELECTABLE_COLUMN_IDS.has(c.id))
        .map((c) => c.id),
    [columnsSignature],
  );
  const colCount = selectableColumnIds.length;
  const rowCount = rows.length;

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
  // The scroll container (holds the data-cell-row/col cells), captured from the
  // first pointer/key interaction — needed by the document paste listener, which
  // has no event target of its own.
  const containerElRef = React.useRef<HTMLElement | null>(null);
  // Firefox paste fallback timer id, shared so the document paste handler can
  // synchronously cancel it (the double-paste guard).
  const fallbackPasteTimerRef = React.useRef<number | null>(null);

  // Clear selection whenever the data window shifts under it — sort, filters,
  // global filter, or pagination all remap row indices, so a stale rect would
  // highlight the wrong cells. Composed as a signature string; the effect fires
  // only when it actually changes.
  const state = table.getState();
  // The four state slices are referentially stable between actual changes, so
  // memoizing keeps the JSON.stringify off every render (incl. per-tick drag
  // updates), running it only when one of them changes.
  const dataSignature = React.useMemo(
    () =>
      JSON.stringify({
        sorting: state.sorting,
        columnFilters: state.columnFilters,
        globalFilter: state.globalFilter ?? null,
        pagination: state.pagination,
      }),
    [state.sorting, state.columnFilters, state.globalFilter, state.pagination],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataSignature is the intended trigger
  React.useEffect(() => {
    setSelection(null);
  }, [dataSignature]);

  // Clamp into bounds when the row count or column count shrinks (a delete, a
  // hidden column). Returns the SAME reference when nothing moved so unrelated
  // length changes (growth) don't churn every row's memo.
  useIsomorphicLayoutEffect(() => {
    setSelection((prev) => {
      if (!prev) return prev;
      const clamped = clampSelection(prev, rowCount, colCount);
      if (
        clamped &&
        clamped.anchor.row === prev.anchor.row &&
        clamped.anchor.col === prev.anchor.col &&
        clamped.focus.row === prev.focus.row &&
        clamped.focus.col === prev.focus.col
      ) {
        return prev;
      }
      return clamped;
    });
  }, [rowCount, colCount]);

  // Per-row selection projection: computed once per selection change into a
  // Map, so each in-rect row gets ONE stable object across renders (out-of-rect
  // rows resolve to `undefined`). The DesktopDataRow memo compares field values,
  // so even a fresh Map on a new selection only re-renders rows whose highlight
  // actually differs.
  const rowSelectionMap = React.useMemo(() => {
    if (!selection) return null;
    const rect = selectionRect(selection);
    const cols = selectableColumnIds.slice(rect.left, rect.right + 1);
    const colsKey = cols.join(",");
    const anchorColId = selectableColumnIds[selection.anchor.col] ?? null;
    const map = new Map<number, RowCellSelection>();
    for (let r = rect.top; r <= rect.bottom; r++) {
      map.set(r, {
        colsKey,
        anchorColId: r === selection.anchor.row ? anchorColId : null,
      });
    }
    return map;
  }, [selection, selectableColumnIds]);

  const getRowCellSelection = React.useCallback(
    (rowIndex: number): RowCellSelection | undefined =>
      rowSelectionMap?.get(rowIndex),
    [rowSelectionMap],
  );

  const endDrag = React.useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    if (windowMouseUpRef.current) {
      window.removeEventListener("mouseup", windowMouseUpRef.current);
      windowMouseUpRef.current = null;
    }
  }, []);

  // Detach a lingering window listener on unmount.
  React.useEffect(() => {
    return () => {
      if (windowMouseUpRef.current) {
        window.removeEventListener("mouseup", windowMouseUpRef.current);
      }
    };
  }, []);

  const resolveCoord = React.useCallback(
    (target: EventTarget | null): CellCoord | null => {
      if (!(target instanceof HTMLElement)) return null;
      const td = target.closest("td[data-cell-col]");
      const tr = target.closest("tr[data-cell-row]");
      if (!td || !tr) return null;
      const colId = td.getAttribute("data-cell-col");
      const rowAttr = tr.getAttribute("data-cell-row");
      if (colId === null || rowAttr === null) return null;
      const col = selectableColumnIdsRef.current.indexOf(colId);
      const row = Number(rowAttr);
      if (col < 0 || Number.isNaN(row)) return null;
      return { row, col };
    },
    [],
  );

  const onMouseDown = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Left button only; let ctrl/meta-click through (native context menu /
      // OS-level multi-select gestures, and Phase-5 additive selection).
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const coord = resolveCoord(e.target);
      if (!coord) return;
      // Capture the container for the document paste listener (a mouse-built
      // selection may be pasted into before any keydown fires).
      containerElRef.current = e.currentTarget;

      if (e.shiftKey) {
        // Extend from the existing anchor. preventDefault kills the text
        // selection a shift-click would otherwise sweep from the last caret.
        e.preventDefault();
        setSelection((prev) =>
          prev
            ? { anchor: prev.anchor, focus: coord }
            : { anchor: coord, focus: coord },
        );
        return;
      }

      // Plain mousedown: collapse to this cell and arm a drag. NOT
      // preventDefault'd — buttons/links inside the cell still need their click.
      setSelection({ anchor: coord, focus: coord });
      draggingRef.current = true;
      setDragging(true);
      const handler = () => endDrag();
      windowMouseUpRef.current = handler;
      window.addEventListener("mouseup", handler);
    },
    [resolveCoord, endDrag],
  );

  const onMouseOver = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const coord = resolveCoord(e.target);
      if (!coord) return;
      setSelection((prev) => {
        if (!prev) return prev;
        if (prev.focus.row === coord.row && prev.focus.col === coord.col) {
          return prev; // same cell — skip the state churn
        }
        return { anchor: prev.anchor, focus: coord };
      });
    },
    [resolveCoord],
  );

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
      navigator.clipboard
        ?.writeText(tsv)
        .catch(() => toast.error("Couldn't access the clipboard to copy"));
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
        const next = moveFocus(
          selectionRef.current,
          dir,
          e.shiftKey,
          rowCount,
          colCount,
        );
        setSelection(next);
        if (next) scrollToFlatRow(next.focus.row);
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
          setSelection(null);
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
    ],
  );

  const containerProps = React.useMemo<ContainerProps>(() => {
    if (!enabled) return EMPTY_CONTAINER_PROPS;
    return {
      onKeyDown,
      onMouseDown,
      onMouseOver,
      "data-cell-dragging": dragging ? "" : undefined,
    };
  }, [enabled, onKeyDown, onMouseDown, onMouseOver, dragging]);

  return {
    selection: enabled ? selection : null,
    getRowCellSelection: enabled ? getRowCellSelection : returnUndefined,
    containerProps,
  };
}

function returnUndefined(): undefined {
  return undefined;
}
