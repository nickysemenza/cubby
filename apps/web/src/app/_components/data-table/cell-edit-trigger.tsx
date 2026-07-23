"use client";

import { Pencil } from "lucide-react";
import * as React from "react";
import { cn } from "~/lib/utils";
import {
  type CellClipboardSpec,
  registerCellClipboard,
} from "./cell-clipboard";
import {
  CELL_EDIT_EVENT,
  CellSelectionContext,
} from "./cell-selection-context";

interface CellEditTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** React 19 ref-as-prop (forwardRef is deprecated). */
  ref?: React.Ref<HTMLButtonElement>;
  onStartEdit: () => void;
  /** Register for cmd-C / cmd-V while this trigger is focused. */
  clipboard?: CellClipboardSpec;
  /** Hide the trailing hover pencil (e.g. icon-only pencil triggers). */
  hidePencilIcon?: boolean;
}

/**
 * The shared display-mode button for editable cells: click (or focus) to
 * edit, hover-revealed pencil, focus ring (the raw buttons it replaced had
 * none, which made keyboard focus — and therefore cell copy/paste —
 * invisible), and the clipboard registration target. The explicit `.focus()`
 * on click matters: Safari/Firefox don't focus buttons on click, and the
 * clipboard listeners key off document.activeElement.
 */
export function CellEditTrigger({
  ref: forwardedRef,
  onStartEdit,
  clipboard,
  hidePencilIcon,
  className,
  children,
  ...rest
}: CellEditTriggerProps) {
  const localRef = React.useRef<HTMLButtonElement | null>(null);
  const setRef = (node: HTMLButtonElement | null) => {
    localRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
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
    const handler = () => onStartEditRef.current();
    el.addEventListener(CELL_EDIT_EVENT, handler);
    return () => el.removeEventListener(CELL_EDIT_EVENT, handler);
  }, []);

  React.useEffect(() => {
    const el = localRef.current;
    if (!el || !hasClipboard) return;
    return registerCellClipboard(el, {
      get kindKey() {
        return clipboardRef.current?.kindKey ?? "";
      },
      getCopyPayload: () => clipboardRef.current?.getCopyPayload?.() ?? null,
      onPasteValue: (payload) =>
        clipboardRef.current?.onPasteValue?.(payload) ?? Promise.resolve(),
      isEditing: () => clipboardRef.current?.isEditing?.() ?? false,
    });
  }, [hasClipboard]);

  return (
    <button
      type="button"
      ref={setRef}
      data-cell-edit-trigger=""
      className={cn(
        "group inline-flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      {...rest}
    >
      {children}
      {!hidePencilIcon && (
        <Pencil className="ml-1 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
