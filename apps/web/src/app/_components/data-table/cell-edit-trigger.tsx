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
  type CellEditEventDetail,
  CellSelectionContext,
} from "./cell-selection-context";

interface CellEditTriggerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** React 19 ref-as-prop (forwardRef is deprecated). */
  ref?: React.Ref<HTMLSpanElement>;
  /**
   * Open the editor. `seedText` (type-to-edit) is threaded from
   * {@link CELL_EDIT_EVENT}'s detail; click/double-click open with no seed.
   */
  onStartEdit: (seedText?: string) => void;
  /** Register for cmd-C / cmd-V while this trigger is focused. */
  clipboard?: CellClipboardSpec;
  /** Hide the trailing hover pencil (e.g. icon-only pencil triggers). */
  hidePencilIcon?: boolean;
}

/**
 * Fences a link rendered INSIDE a {@link CellEditTrigger} from the trigger's
 * own click, so clicking the text navigates only.
 *
 * TanStack's `<Link>` calls `preventDefault` but not `stopPropagation`, so
 * without this the click also reaches the trigger button — which outside
 * cell-selection mode opens the editor on the very click that swaps the route
 * (the editor unmounts mid-edit; this failed CI E2E once already, see
 * `createNameColumn`), and inside cell-selection mode makes the cell
 * impossible to double-click-edit at all, since click #1 navigates away.
 *
 * Only `click` is stopped — selection is driven by `mousedown`, which must
 * keep bubbling for the range engine to see it.
 *
 * (`createNameColumn` inlines this same guard rather than using this
 * component: its span carries a width/truncate class and is consumed as a
 * `TooltipTrigger` render target, so it can't be a wrapper.)
 */
export function CellLinkFence({ children }: { children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: not interactive itself — only fences the inner link's click from the edit trigger
    <span onClick={(e) => e.stopPropagation()}>{children}</span>
  );
}

/**
 * The shared display-mode trigger for editable cells: click (or focus) to
 * edit, hover-revealed pencil, focus ring (the raw buttons it replaced had
 * none, which made keyboard focus — and therefore cell copy/paste —
 * invisible), and the clipboard registration target. The explicit `.focus()`
 * on click matters: Safari/Firefox don't focus buttons on click, and the
 * clipboard listeners key off document.activeElement.
 *
 * A `<span role="button">`, NOT a `<button>`. Cells legitimately render rich
 * content inside this trigger — links, badges, a `TruncatedList` overflow
 * popover — and `<button>`/`<a>` inside `<button>` is invalid HTML. The tags
 * cell on /recipes hit the parser rule React actually warns about ("<button>
 * cannot be a descendant of <button>"), which cost the whole subtree its SSR
 * markup; eight more sites nest an `<a>`, equally invalid but unwarned.
 * `useCellSelection` already assumes this ("buttons/links inside the cell
 * still need their click"), so the element was the thing in the wrong.
 *
 * A span, not a div: this renders inside `InfoRow`'s value `<span>` on every
 * detail page, where a div would be flow content inside phrasing content —
 * the same class of invalid nesting, just one React doesn't flag.
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
  const localRef = React.useRef<HTMLSpanElement | null>(null);
  const setRef = (node: HTMLSpanElement | null) => {
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
    const handler = (e: Event) => {
      const seedText = (e as CustomEvent<CellEditEventDetail>).detail?.seedText;
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
      onPasteValue: (payload) =>
        clipboardRef.current?.onPasteValue?.(payload) ?? Promise.resolve(),
      isEditing: () => clipboardRef.current?.isEditing?.() ?? false,
    });
  }, [hasClipboard, cellSelectionMode]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: must not be a <button> — cells render links/popovers inside it (see the doc comment)
    <span
      role="button"
      // Load-bearing, not cosmetic: useCellSelection focuses this element
      // before dispatching CELL_EDIT_EVENT, and the editor refocuses it on
      // cancel. A span without tabIndex silently swallows both.
      tabIndex={0}
      ref={setRef}
      data-cell-edit-trigger=""
      className={cn(
        // `select-none` replaces what <button> gave for free: double-click is
        // the edit gesture in cell-selection mode, and on a selectable span it
        // would paint a native word selection under the editor.
        "group inline-flex select-none items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted",
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
      // Keyboard activation, which <button> used to provide. Gated exactly
      // like onClick: in cell-selection mode the CONTAINER owns Enter and
      // every printable key (Space included, seeding " "), and since React
      // bubbles target→container this handler would run FIRST — the
      // container's preventDefault can't retract it, so it would open the
      // editor twice. preventDefault on Space also stops the page scroll a
      // <button> used to suppress.
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
    >
      {children}
      {!hidePencilIcon && (
        <Pencil className="ml-1 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </span>
  );
}
