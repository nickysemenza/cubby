"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Fixed-position style covering an anchor cell, Notion-style: slightly
 * outset from the anchor rect, at least as wide, clamped to the viewport.
 * Recomputes on resize and (capture-phase) scroll — same approach as
 * DialogCompatibleCombobox's dropdown positioning, minus the flip/height
 * logic that is dropdown-specific.
 */
function useAnchoredOverlayStyle(
  anchorEl: HTMLElement | null,
  opts?: { maxWidth?: number },
): React.CSSProperties | null {
  const maxWidth = opts?.maxWidth ?? 420;
  const [style, setStyle] = React.useState<React.CSSProperties | null>(null);

  const update = React.useCallback(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const viewportPadding = 8;
    const viewportWidth = window.innerWidth;
    const minWidth = Math.min(
      rect.width + 16,
      viewportWidth - viewportPadding * 2,
    );
    const left = Math.min(
      Math.max(rect.left - 8, viewportPadding),
      Math.max(viewportPadding, viewportWidth - minWidth - viewportPadding),
    );
    setStyle({
      position: "fixed",
      top: rect.top - 4,
      left,
      minWidth,
      maxWidth,
      // Above the sticky table chrome, below the combobox dropdown (z-200)
      // so a picker's options always paint over the editor surface.
      zIndex: 100,
    });
  }, [anchorEl, maxWidth]);

  React.useEffect(() => {
    if (!anchorEl) {
      setStyle(null);
      return;
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorEl, update]);

  return style;
}

const OVERLAY_GUARDED_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Escape",
]);

/**
 * Portals an inline-cell editor OVER its cell so it can be wider than the
 * `table-fixed` column (body cells are `overflow-hidden`, which used to clip
 * the editor's Check/✗ buttons). The display trigger stays mounted in the
 * cell as the positioning anchor.
 *
 * Rendered from within the cell component on purpose: React portals bubble
 * synthetic events through the React tree, so the root's stopPropagation
 * still shields the row's onClick and the table container's row-nav keydown.
 */
export function CellEditorOverlay({
  anchorEl,
  onRequestCancel,
  children,
}: {
  anchorEl: HTMLElement | null;
  onRequestCancel: () => void;
  children: React.ReactNode;
}) {
  const style = useAnchoredOverlayStyle(anchorEl);
  const overlayRef = React.useRef<HTMLDivElement>(null);

  // Document-level Escape: focus can legitimately sit OUTSIDE the overlay
  // (the trigger keeps focus after the opening click), where the overlay's
  // own onKeyDown never fires. Editors that handle Escape themselves (the
  // comboboxes closing their dropdown) stopPropagation, which also stops the
  // native event from reaching this listener — two-level Escape holds.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onRequestCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onRequestCancel]);

  // Click-outside cancels. DOM containment (not React tree) is the reliable
  // check here: the combobox dropdown and the `Popover` primitive (e.g. the
  // date-picker's Calendar) are their own body-level portals, so allow
  // clicks inside either to keep the editor open.
  React.useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (overlayRef.current?.contains(target)) return;
      if (
        target.closest?.('[data-combobox-popup], [data-slot="popover-content"]')
      )
        return;
      if (anchorEl?.contains(target)) return;
      onRequestCancel();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [anchorEl, onRequestCancel]);

  if (typeof document === "undefined" || !style) return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: propagation guards for row click + table row-nav keys
    <div
      ref={overlayRef}
      style={style}
      className="w-max rounded-md border bg-popover px-2 py-1"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Editor keys must not reach the table container's row-nav handler
        // (portal bubbling goes through the React tree). Escape with the
        // combobox dropdown open never gets here — the combobox stops its
        // own Escape — so this is the "second Escape" that cancels the edit.
        if (!OVERLAY_GUARDED_KEYS.has(e.key)) return;
        e.stopPropagation();
        if (e.key === "Escape") onRequestCancel();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
