"use client";

import { Pencil } from "lucide-react";
import * as React from "react";

import { useHydrationGate } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

import {
  type CellClipboardSpec,
  registerCellClipboard,
} from "./cell-clipboard";
import {
  CELL_EDIT_EVENT,
  type CellEditEventDetail,
  CellSelectionContext,
} from "./cell-selection-context";

interface CellEditTriggerProps<
  TSaved,
> extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** React 19 ref-as-prop (forwardRef is deprecated). */
  ref?: React.Ref<HTMLButtonElement>;
  /**
   * Open the editor. `seedText` (type-to-edit) is threaded from
   * {@link CELL_EDIT_EVENT}'s detail; click/double-click open with no seed.
   */
  onStartEdit: (seedText?: string) => void;
  /** Register for cmd-C / cmd-V while this trigger is focused. */
  clipboard?: CellClipboardSpec<TSaved>;
  /** Hide the trailing hover pencil (e.g. icon-only pencil triggers). */
  hidePencilIcon?: boolean;
}

function isRefCallback<T>(
  ref: React.Ref<T> | undefined,
): ref is React.RefCallback<T> {
  return typeof ref === "function";
}

function isCellEditEvent(
  event: Event,
): event is CustomEvent<CellEditEventDetail> {
  return event instanceof CustomEvent;
}

/**
 * The shared display-mode trigger for editable cells: click (or focus) to
 * edit, hover-revealed pencil, focus ring (the raw buttons it replaced had
 * none, which made keyboard focus — and therefore cell copy/paste —
 * invisible), and the clipboard registration target. The explicit `.focus()`
 * on click matters: Safari/Firefox don't focus buttons on click, and the
 * clipboard listeners key off document.activeElement.
 *
 * This is a real button. Callers with links or popovers render that rich
 * content beside a pencil-only trigger instead of nesting controls.
 */
export function CellEditTrigger<TSaved>({
  ref: forwardedRef,
  onStartEdit,
  clipboard,
  hidePencilIcon,
  className,
  children,
  ...rest
}: CellEditTriggerProps<TSaved>) {
  const localRef = React.useRef<HTMLButtonElement | null>(null);
  const setRef = (node: HTMLButtonElement | null) => {
    localRef.current = node;
    if (isRefCallback(forwardedRef)) forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };

  // Inside an RTable with spreadsheet-style cell selection, a single click
  // SELECTS the cell (the container drives selection off mousedown); editing
  // opens on double-click or Enter (dispatched as CELL_EDIT_EVENT). Outside
  // that context (detail pages, dialogs) the original click-to-edit stands.
  const cellSelectionMode = React.useContext(CellSelectionContext);

  // Keep the latest spec in a ref so registration survives re-renders without
  // listener churn; the registry reads through the stable wrapper below.
  const clipboardRef = React.useRef(clipboard);
  clipboardRef.current = clipboard;
  const hasClipboard = clipboard !== undefined;

  // Ref-latched onStartEdit so the CELL_EDIT_EVENT listener (registered once)
  // always calls the current handler without re-subscribing each render.
  const onStartEditRef = React.useRef(onStartEdit);
  onStartEditRef.current = onStartEdit;
  React.useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      if (!isCellEditEvent(e)) return;
      const seedText = e.detail?.seedText;
      onStartEditRef.current(seedText);
    };
    el.addEventListener(CELL_EDIT_EVENT, handler);
    return () => el.removeEventListener(CELL_EDIT_EVENT, handler);
  }, []);

  // In cell-selection mode the range engine (useCellSelection) owns ALL
  // copy/paste — clicking a cell focuses this trigger, and the legacy document
  // paste listener registers before the range one, so registering here would
  // let a real Cmd+V paste the raw TSV blob into the anchor cell (numeric
  // columns digit-strip it: "10\t20\n30\t40" → 10203040) before the range
  // paste runs. Registry stays for out-of-table cells (detail pages, dialogs).
  React.useEffect(() => {
    const el = localRef.current;
    if (!el || !hasClipboard || cellSelectionMode) return;
    return registerCellClipboard(el, {
      get kindKey() {
        return clipboardRef.current?.kindKey ?? "";
      },
      getCopyPayload: () => clipboardRef.current?.getCopyPayload?.() ?? null,
      onPasteValue: async (payload) => {
        await clipboardRef.current?.onPasteValue?.(payload);
      },
      isEditing: () => clipboardRef.current?.isEditing?.() ?? false,
    });
  }, [hasClipboard, cellSelectionMode]);

  const gate = useHydrationGate(rest.disabled);
  return (
    <button
      type="button"
      ref={setRef}
      data-cell-edit-trigger=""
      className={cn(
        // `select-none` replaces what <button> gave for free: double-click is
        // the edit gesture in cell-selection mode, and on a selectable span it
        // would paint a native word selection under the editor.
        "group inline-flex items-center gap-1 px-2 py-1 text-left select-none hover:bg-muted",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        "data-[clipboard-flash]:ring-2 data-[clipboard-flash]:ring-ring",
        className,
      )}
      onClick={(e) => {
        // stopPropagation kept so a trigger click never bubbles to the row's
        // onClick (navigate/open). Selection is driven by mousedown, which is
        // NOT stopped, so clicking the cell still selects it.
        e.stopPropagation();
        e.currentTarget.focus();
        // Cell-selection mode: click only focuses/selects; edit opens on
        // double-click or Enter. Otherwise keep the original click-to-edit.
        if (!cellSelectionMode) onStartEdit();
      }}
      onDoubleClick={cellSelectionMode ? () => onStartEdit() : undefined}
      // In cell-selection mode the container owns Enter and printable keys.
      onKeyDown={
        cellSelectionMode
          ? undefined
          : (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onStartEdit();
            }
      }
      {...rest}
      {...gate}
    >
      {children}
      {!hidePencilIcon && (
        <Pencil className="ml-1 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100" />
      )}
    </button>
  );
}
