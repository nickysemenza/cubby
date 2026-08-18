"use client";

/**
 * Thin adapter around v9's native mouse/touch resize handler. With
 * `columnResizeMode: "onEnd"`, the table commits once at gesture end and the
 * external layout atom persists that committed width.
 */
export function ColumnResizeHandle({
  onResizeStart,
  onReset,
}: {
  /**
   * Must be the handler returned by `header.getResizeHandler()`, not the
   * method itself. v9's header method reads `this`, so passing the bare
   * prototype function loses the header instance before a resize can begin.
   */
  onResizeStart: (event: unknown) => void;
  onReset: () => void;
}) {
  return (
    <div
      aria-hidden="true"
      title="Drag to resize · double-click to reset"
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-primary/50 group-hover/th:bg-border data-[dragging]:bg-primary"
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
