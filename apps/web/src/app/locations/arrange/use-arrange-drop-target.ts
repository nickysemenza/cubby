import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useDroppable } from "@dnd-kit/core";
import { useEffect, useId, useRef } from "react";
import { canDropOnArrangeTarget } from "./arrange-drop-policy";
import type { ArrangeDropData } from "./arrange-types";
import { useArrangeDndState } from "./use-arrange-dnd";

interface ArrangeDropTargetOptions {
  roots: InfLocation[];
  locationId: LocationShortcode | null;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
}

/** Registers a typed dnd-kit target and exposes valid-hover state. */
export function useArrangeDropTarget({
  roots,
  locationId,
  onDragEnter,
  onDragLeave,
  onDrop,
}: ArrangeDropTargetOptions) {
  const targetInstanceId = useId();
  const data: ArrangeDropData = { arrangeTarget: true, locationId };
  const { setNodeRef, isOver } = useDroppable({
    // A location can be visible simultaneously as a row, column body, and
    // breadcrumb. dnd-kit IDs identify DOM registrations, so keep the policy
    // identity in data and qualify each rendered target independently.
    id: `arrange-target:${locationId ?? "home"}:${targetInstanceId}`,
    data,
  });
  const { active } = useArrangeDndState();
  const valid = !!active && canDropOnArrangeTarget(roots, locationId, active);
  const wasOver = useRef(false);
  useEffect(() => {
    const next = isOver && valid;
    if (next && !wasOver.current) onDragEnter?.();
    if (!next && wasOver.current) onDragLeave?.();
    wasOver.current = next;
  }, [isOver, valid, onDragEnter, onDragLeave]);
  useEffect(
    () => () => {
      if (wasOver.current) onDrop?.();
    },
    [onDrop],
  );
  return { setNodeRef, isOver: isOver && valid };
}
