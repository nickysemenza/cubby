"use client";

import type { TableMeta } from "@tanstack/react-table";
import type * as React from "react";

/**
 * Drag handle at a header cell's right edge for column resizing. Lives in the
 * header `th` (which must be `position: relative`). On drag it measures the
 * `th`'s current pixel width and writes deltas through the table meta's
 * `setColumnSize`; double-click resets to the code-defined width. Under the
 * table's `table-fixed` layout, sizing the header cell resizes the whole
 * column — no body-row work.
 */
export function ColumnResizeHandle<TData>({
  columnId,
  meta,
}: {
  columnId: string;
  meta: TableMeta<TData> | undefined;
}) {
  const setColumnSize = meta?.setColumnSize;
  const resetColumnSize = meta?.resetColumnSize;
  if (!setColumnSize) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't start a sort toggle or text selection while dragging.
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th");
    if (!th) return;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;

    const onMove = (ev: MouseEvent) => {
      setColumnSize(columnId, startWidth + (ev.clientX - startX));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-primary/50"
      onMouseDown={handleMouseDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        resetColumnSize?.(columnId);
      }}
    />
  );
}
