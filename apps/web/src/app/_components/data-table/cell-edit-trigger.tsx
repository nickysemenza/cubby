"use client";

import { Pencil } from "lucide-react";
import * as React from "react";
import { cn } from "~/lib/utils";
import {
  type CellClipboardSpec,
  registerCellClipboard,
} from "./cell-clipboard";

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

  // Keep the latest spec in a ref so registration survives re-renders without
  // listener churn; the registry reads through the stable wrapper below.
  const clipboardRef = React.useRef(clipboard);
  clipboardRef.current = clipboard;
  const hasClipboard = clipboard !== undefined;

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
      className={cn(
        "group inline-flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "data-[clipboard-flash]:ring-2 data-[clipboard-flash]:ring-ring",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        e.currentTarget.focus();
        onStartEdit();
      }}
      {...rest}
    >
      {children}
      {!hidePencilIcon && (
        <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
