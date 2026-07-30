"use client";

import type * as React from "react";
import { MIN_COLUMN_WIDTH } from "./useTableColumnSizing";

/**
 * Drag handle at a header cell's right edge for column resizing. Lives in the
 * header `th` (which must be `position: relative` and carry `group/th`). Under
 * the table's `table-fixed` layout, sizing the header cell resizes the whole
 * column — no body-row work.
 *
 * The drag writes width straight onto the `th` element and commits through
 * `onCommit` ONCE on mouseup. Committing per `mousemove` would mean a
 * synchronous `localStorage.setItem` plus a full table re-render per pixel.
 * Double-click resets to the code-defined width.
 *
 * Renders nothing without `onCommit` — that's how a table opts out of resizing.
 */
export function ColumnResizeHandle({
  columnId,
  onCommit,
  onReset,
}: {
  columnId: string;
  onCommit: ((columnId: string, width: number) => void) | undefined;
  onReset: ((columnId: string) => void) | undefined;
}) {
  if (!onCommit) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't start a sort toggle or text selection while dragging.
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const th = handle.closest("th");
    if (!th) return;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;
    let width = startWidth;
    handle.dataset.dragging = "true";

    const onMove = (ev: MouseEvent) => {
      width = Math.max(MIN_COLUMN_WIDTH, startWidth + (ev.clientX - startX));
      // Direct DOM write: the live drag must not re-render the table.
      th.style.width = `${width}px`;
      th.style.minWidth = `${width}px`;
      th.style.maxWidth = `${width}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      delete handle.dataset.dragging;
      // Hand the final width to React; the committed style replaces the
      // inline one we wrote above on the next render.
      if (width !== startWidth) onCommit(columnId, width);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      aria-hidden="true"
      title="Drag to resize · double-click to reset"
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-primary/50 group-hover/th:bg-border data-[dragging]:bg-primary"
      onMouseDown={handleMouseDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset?.(columnId);
      }}
    />
  );
}
