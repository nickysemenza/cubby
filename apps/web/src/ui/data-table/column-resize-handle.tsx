"use client";

import type * as React from "react";
import type { MouseEvent, TouchEvent } from "react";

type ResizeStartEvent = MouseEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>;

/**
 * Thin adapter around v9's native mouse/touch resize handler. With
 * `columnResizeMode: "onEnd"`, the table commits once at gesture end and the
 * table retains that width for the current session.
 */
export function ColumnResizeHandle({
  onResizeStart,
  onReset,
  dragging,
  deltaOffset,
}: {
  dragging: boolean;
  deltaOffset: number;
  /**
   * Must be the handler returned by `header.getResizeHandler()`, not the
   * method itself. v9's header method reads `this`, so passing the bare
   * prototype function loses the header instance before a resize can begin.
   */
  onResizeStart: (event: ResizeStartEvent) => void;
  onReset: () => void;
}) {
  // SAFETY: React CSSProperties omits custom properties; this value is a CSS pixel length.
  const style = { "--resize-delta": `${deltaOffset}px` } as React.CSSProperties;
  return (
    <div
      aria-hidden="true"
      title="Drag to resize · double-click to reset"
      data-dragging={dragging ? "" : undefined}
      className="table-resize-handle absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none"
      style={style}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onResizeStart(event);
      }}
      onTouchStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onResizeStart(event);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
    />
  );
}
