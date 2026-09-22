import type { RowData } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";

import { showErrorToast } from "~/components/feedback/error-details";
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
  /** Imperative projection for tests and keyboard/clipboard transports. */
  getSelection: () => CellSelection | null;
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
type CellMoveDirection = "up" | "down" | "left" | "right";

const ARROW_DIRECTION = new Map<string, CellMoveDirection>([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
] as const);

interface CellKeyContext<TItem extends RowData> {
  rows: Row<TItem>[];
  table: ITable<TItem>;
  selectableColumnIds: React.RefObject<string[]>;
  fallbackPasteTimer: React.RefObject<number | null>;
  getSelection: () => CellSelection | null;
  scrollToFlatRow: (rowIndex: number) => void;
  onOpenRow?: (row: Row<TItem>) => void;
  openEditorAt: (
    container: HTMLElement,
    row: number,
    col: number,
    seedText?: string,
  ) => void;
  doCopy: (container: HTMLElement) => void;
  doPaste: (container: HTMLElement, clipboardText: string) => Promise<void>;
  doClear: (container: HTMLElement) => boolean;
}

function handleClipboardKey<TItem extends RowData>(
  event: React.KeyboardEvent<HTMLDivElement>,
  context: CellKeyContext<TItem>,
) {
  if (event.key === "Delete" || event.key === "Backspace") {
    if (context.doClear(event.currentTarget)) event.preventDefault();
    return true;
  }
  const isMod = event.metaKey || event.ctrlKey;
  if (isMod && (event.key === "c" || event.key === "C")) {
    if (!context.getSelection()) return true;
    event.preventDefault();
    context.doCopy(event.currentTarget);
    return true;
  }
  if (!isMod || (event.key !== "v" && event.key !== "V")) return false;
  if (!context.getSelection()) return true;
  const container = event.currentTarget;
  if (context.fallbackPasteTimer.current !== null) {
    window.clearTimeout(context.fallbackPasteTimer.current);
  }
  context.fallbackPasteTimer.current = window.setTimeout(() => {
    context.fallbackPasteTimer.current = null;
    const buffer = getCopyBuffer();
    if (buffer) void context.doPaste(container, buffer.tsv);
  }, FIREFOX_PASTE_FALLBACK_MS);
  return true;
}

function handleArrowKey<TItem extends RowData>(
  event: React.KeyboardEvent<HTMLDivElement>,
  context: CellKeyContext<TItem>,
) {
  const direction = ARROW_DIRECTION.get(event.key);
  if (!direction || event.metaKey || event.ctrlKey) return false;
  event.preventDefault();
  if (!context.getSelection()) {
    const firstRow = context.rows[0];
    const firstColumnId = context.selectableColumnIds.current[0];
    if (firstRow && firstColumnId) {
      context.table.setFocusedCell(firstRow.id, firstColumnId);
    }
  } else if (event.shiftKey) {
    context.table.extendCellSelection(direction);
  } else {
    context.table.moveCellSelection(direction);
  }
  const focused = context.table.getFocusedCell();
  if (focused) {
    const nextRow = context.rows.findIndex((row) => row.id === focused.row.id);
    if (nextRow >= 0) context.scrollToFlatRow(nextRow);
  }
  return true;
}

function handleEditKey<TItem extends RowData>(
  event: React.KeyboardEvent<HTMLDivElement>,
  context: CellKeyContext<TItem>,
) {
  if (event.key === "Escape") {
    if (context.getSelection()) {
      event.preventDefault();
      context.table.resetCellSelection(true);
    }
    return true;
  }
  const selection = context.getSelection();
  if (event.key === "Enter") {
    event.preventDefault();
    if (!selection) return true;
    if (event.metaKey || event.ctrlKey) {
      const row = context.rows[selection.anchor.row];
      if (row) context.onOpenRow?.(row);
    } else {
      context.openEditorAt(
        event.currentTarget,
        selection.anchor.row,
        selection.anchor.col,
      );
    }
    return true;
  }
  if (selection && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    context.openEditorAt(
      event.currentTarget,
      selection.anchor.row,
      selection.anchor.col,
      event.key,
    );
  }
}

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
    // oxlint-disable-next-line react/exhaustive-deps -- signature stands in for the column list
    [columnsSignature],
  );
  const colCount = selectableColumnIds.length;
  const rowCount = rows.length;

  // Live refs keep clipboard/keyboard transports out of the table owner's
  // render subscription. Individual rows subscribe to v9's selection atom;
  // handlers read that same atom imperatively when an interaction occurs.
  const selectableColumnIdsRef = React.useRef(selectableColumnIds);
  selectableColumnIdsRef.current = selectableColumnIds;
  // Live rows ref so the document paste listener + timer (which close over one
  // render) read the current row model without re-installing on every data tick.
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  const getSelection = React.useCallback((): CellSelection | null => {
    const range = table.atoms.cellSelection!.get().at(-1);
    if (!range) return null;
    const currentRows = rowsRef.current;
    const columns = selectableColumnIdsRef.current;
    const anchor = {
      row: currentRows.findIndex((row) => row.id === range.anchorRowId),
      col: columns.indexOf(range.anchorColumnId),
    };
    const focus = {
      row: currentRows.findIndex((row) => row.id === range.focusRowId),
      col: columns.indexOf(range.focusColumnId),
    };
    return anchor.row < 0 || anchor.col < 0 || focus.row < 0 || focus.col < 0
      ? null
      : { anchor, focus };
  }, [table]);
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
  React.useEffect(() => {
    resetCellSelection(true);
  }, [layoutSignature, resetCellSelection]);

  // Appends preserve id corners. A replacement/removal clears only when a
  // corner actually disappeared; width and density changes never touch ids.
  React.useEffect(() => {
    const nativeSelection = table.atoms.cellSelection!.get();
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
  }, [table, rows, selectableColumnIds, resetCellSelection]);

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
      const sel = getSelection();
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
    [buildColumnCellData, flashCoords, getSelection],
  );

  const doPaste = React.useCallback(
    async (container: HTMLElement, clipboardText: string) => {
      const sel = getSelection();
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
    [buildColumnCellData, flashCoords, getSelection],
  );

  const doClear = React.useCallback(
    (container: HTMLElement): boolean => {
      const target = resolveCellClearTarget({
        selection: getSelection(),
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
        .catch((error) => showErrorToast(error))
        .finally(() => {
          clearPendingRef.current = false;
        });
      return true;
    },
    [buildColumnCellData, flashCoords, getSelection],
  );

  // Primary paste transport: a document-level listener, live only while a
  // selection exists. Chrome/Safari dispatch `paste` to the focused container.
  React.useEffect(() => {
    if (!enabled) return;
    const handler = (event: ClipboardEvent) => {
      // Double-paste guard: cancel the Firefox keydown fallback SYNCHRONOUSLY,
      // before anything else, so it can't also fire.
      if (fallbackPasteTimerRef.current !== null) {
        window.clearTimeout(fallbackPasteTimerRef.current);
        fallbackPasteTimerRef.current = null;
      }
      // An open editor (input/textarea/contenteditable) owns paste.
      if (isTypingTarget(document.activeElement)) return;
      if (!getSelection()) return;
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
  }, [enabled, doPaste, getSelection]);

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
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The container has focusable children (header filter inputs, cell
      // trigger buttons); key events bubble up here. Never hijack typing in an
      // input/textarea/select/contenteditable (an open editor or a filter).
      if (isTypingTarget(document.activeElement)) return;
      // React also bubbles keys from portaled descendants (a bulk-edit dialog
      // opened from this table) through here; only keys whose DOM target is
      // inside the grid are table keys. Otherwise, with a cell selected, Space
      // in that dialog opened a cell editor instead of pressing its button.
      if (
        event.target instanceof Node &&
        !event.currentTarget.contains(event.target)
      )
        return;
      if (rowCount === 0 || colCount === 0) return;

      containerElRef.current = event.currentTarget;
      const context: CellKeyContext<TItem> = {
        rows,
        table,
        selectableColumnIds: selectableColumnIdsRef,
        fallbackPasteTimer: fallbackPasteTimerRef,
        getSelection,
        scrollToFlatRow,
        onOpenRow,
        openEditorAt,
        doCopy,
        doPaste,
        doClear,
      };
      if (handleClipboardKey(event, context)) return;
      if (handleArrowKey(event, context)) return;
      handleEditKey(event, context);
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
      getSelection,
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
    getSelection,
    containerProps,
  };
}
