export interface DndPoint {
  x: number;
  y: number;
}

export type DndAutoScrollAxis = "horizontal" | "vertical" | "both";

export interface DndAutoScrollOptions {
  axis?: DndAutoScrollAxis;
  edgeSize?: number;
  maxSpeed?: number;
  onScroll?: (container: HTMLElement) => void;
}

export interface DndScrollVelocity {
  x: number;
  y: number;
}

function edgeVelocity(
  value: number,
  start: number,
  end: number,
  edgeSize: number,
  maxSpeed: number,
): number {
  if (value < start + edgeSize) {
    return -Math.min(1, (start + edgeSize - value) / edgeSize) * maxSpeed;
  }
  if (value > end - edgeSize) {
    return Math.min(1, (value - (end - edgeSize)) / edgeSize) * maxSpeed;
  }
  return 0;
}

export function computeDndScrollVelocity(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  point: DndPoint,
  {
    axis = "both",
    edgeSize = 32,
    maxSpeed = 18,
  }: Omit<DndAutoScrollOptions, "onScroll"> = {},
): DndScrollVelocity {
  return {
    x:
      axis === "vertical"
        ? 0
        : edgeVelocity(point.x, rect.left, rect.right, edgeSize, maxSpeed),
    y:
      axis === "horizontal"
        ? 0
        : edgeVelocity(point.y, rect.top, rect.bottom, edgeSize, maxSpeed),
  };
}

function containsPoint(element: HTMLElement, point: DndPoint): boolean {
  const rect = element.getBoundingClientRect();
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

/** Prefer the deepest registered scroll region under the pointer. */
export function findDndScrollContainer(
  containers: Iterable<HTMLElement | null>,
  point: DndPoint,
): HTMLElement | null {
  const candidates = [...containers].filter(
    (element): element is HTMLElement =>
      !!element && containsPoint(element, point),
  );
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (
      candidate &&
      candidates.every(
        (other) => candidate === other || !candidate.contains(other),
      )
    ) {
      return candidate;
    }
  }
  return null;
}

export interface DndAutoScroller {
  update(point: DndPoint, containers: Iterable<HTMLElement | null>): void;
  stop(): void;
}

/**
 * One RAF loop for every Cubby drag surface. Call update from dnd-kit's move
 * event; the loop keeps scrolling at the edge until the pointer moves or the
 * drag ends.
 */
export function createDndAutoScroller(
  options: DndAutoScrollOptions = {},
): DndAutoScroller {
  let point: DndPoint | null = null;
  let containers: HTMLElement[] = [];
  let frame = 0;

  const tick = () => {
    frame = 0;
    if (!point) return;
    const container = findDndScrollContainer(containers, point);
    if (!container) return;
    const velocity = computeDndScrollVelocity(
      container.getBoundingClientRect(),
      point,
      options,
    );
    if (velocity.x === 0 && velocity.y === 0) return;
    const beforeX = container.scrollLeft;
    const beforeY = container.scrollTop;
    container.scrollBy({ left: velocity.x, top: velocity.y });
    if (container.scrollLeft === beforeX && container.scrollTop === beforeY) {
      return;
    }
    options.onScroll?.(container);
    frame = requestAnimationFrame(tick);
  };

  return {
    update(nextPoint, nextContainers) {
      point = nextPoint;
      containers = [...nextContainers].filter(
        (element): element is HTMLElement => !!element,
      );
      if (!frame) frame = requestAnimationFrame(tick);
    },
    stop() {
      point = null;
      containers = [];
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
