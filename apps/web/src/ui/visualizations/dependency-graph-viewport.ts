export interface GraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Overview is an explicit action; every new graph starts at normal text size. */
export function overviewScale(graph: GraphRect, viewport: GraphRect): number {
  return Math.min(
    1,
    (viewport.width - 32) / graph.width,
    (viewport.height - 32) / graph.height,
  );
}

/** Reveal a record or group without centering a large region on empty space. */
export function graphScrollTarget(target: GraphRect, viewport: GraphRect) {
  return {
    left: Math.max(
      0,
      target.x -
        (target.width < viewport.width - 48
          ? (viewport.width - target.width) / 2
          : 24),
    ),
    top: Math.max(0, target.y - 48),
  };
}
