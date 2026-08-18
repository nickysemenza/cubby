import {
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

export interface CubbyDndSensorOptions {
  pointerDistance?: number;
  touchDelay?: number;
  touchTolerance?: number;
  keyboardCoordinates?: KeyboardCoordinateGetter;
  immediatePointer?: boolean;
}

type ValidKeyboardTarget = (
  activeData: Record<string, unknown> | undefined,
  targetData: Record<string, unknown> | undefined,
) => boolean;

export function resolveActivatorDistance(
  immediate: boolean,
  distance: string | undefined,
): "immediate" | number | undefined {
  if (immediate) return "immediate";
  if (distance === undefined || distance.trim() === "") return undefined;
  const parsed = Number(distance);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * dnd-kit configures pointer activation per context, while Calendar and Gantt
 * need immediate precise-pointer resize and a shorter create threshold inside
 * the same context as ordinary moves. Activator metadata narrows that gap
 * without affecting touch, which remains owned by the long-press sensor.
 */
class CubbyMouseSensor extends MouseSensor {
  constructor(props: ConstructorParameters<typeof MouseSensor>[0]) {
    const target = props.event.target;
    const activator =
      target instanceof Element
        ? target.closest<HTMLElement>(
            "[data-dnd-immediate], [data-dnd-distance]",
          )
        : null;
    const distance = resolveActivatorDistance(
      activator?.hasAttribute("data-dnd-immediate") ?? false,
      activator?.dataset.dndDistance,
    );
    const activationConstraint =
      distance === "immediate"
        ? undefined
        : distance === undefined
          ? props.options.activationConstraint
          : { distance };
    super({
      ...props,
      options: { ...props.options, activationConstraint },
    });
  }
}

/**
 * Geometry-based keyboard navigation that skips targets rejected by a
 * surface's existing drop policy. This is intentionally policy-free: callers
 * supply the same predicate they use for pointer and touch collisions.
 */
export function createValidTargetKeyboardCoordinates(
  isValid: ValidKeyboardTarget,
): KeyboardCoordinateGetter {
  return (event, { currentCoordinates, context }) => {
    const direction =
      event.code === "ArrowDown"
        ? { x: 0, y: 1 }
        : event.code === "ArrowUp"
          ? { x: 0, y: -1 }
          : event.code === "ArrowRight"
            ? { x: 1, y: 0 }
            : event.code === "ArrowLeft"
              ? { x: -1, y: 0 }
              : null;
    const activeRect = context.collisionRect;
    if (!direction || !context.active || !activeRect) return undefined;
    event.preventDefault();

    const activeCenter = {
      x: activeRect.left + activeRect.width / 2,
      y: activeRect.top + activeRect.height / 2,
    };
    const activeData = context.active.data.current;
    let best:
      | {
          rect: { left: number; top: number; width: number; height: number };
          score: number;
        }
      | undefined;

    for (const container of context.droppableContainers.getEnabled()) {
      const rect = context.droppableRects.get(container.id);
      if (!rect || !isValid(activeData, container.data.current)) continue;
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const primary =
        direction.x !== 0
          ? (center.x - activeCenter.x) * direction.x
          : (center.y - activeCenter.y) * direction.y;
      if (primary <= 0) continue;
      const cross =
        direction.x !== 0
          ? Math.abs(center.y - activeCenter.y)
          : Math.abs(center.x - activeCenter.x);
      const score = primary + cross * 2;
      if (!best || score < best.score) best = { rect, score };
    }

    if (!best) return undefined;
    return {
      x: currentCoordinates.x + best.rect.left - activeRect.left,
      y: currentCoordinates.y + best.rect.top - activeRect.top,
    };
  };
}

/**
 * Cubby's shared input contract for semantic drag-and-drop surfaces.
 *
 * Pointer interactions use a short travel threshold so ordinary clicks remain
 * clicks. Touch requires a deliberate long press so scrolling keeps priority.
 * Resize-only contexts can opt into immediate precise-pointer activation.
 */
export function useCubbyDndSensors({
  pointerDistance = 4,
  touchDelay = 250,
  touchTolerance = 8,
  keyboardCoordinates = sortableKeyboardCoordinates,
  immediatePointer = false,
}: CubbyDndSensorOptions = {}) {
  const pointer = useSensor(
    CubbyMouseSensor,
    immediatePointer
      ? undefined
      : { activationConstraint: { distance: pointerDistance } },
  );
  const touch = useSensor(TouchSensor, {
    activationConstraint: { delay: touchDelay, tolerance: touchTolerance },
  });
  const keyboard = useSensor(KeyboardSensor, {
    coordinateGetter: keyboardCoordinates,
  });

  return useSensors(pointer, touch, keyboard);
}
