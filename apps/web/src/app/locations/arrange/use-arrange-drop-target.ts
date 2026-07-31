import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { type RefObject, useEffect, useRef, useState } from "react";
import { canDropOnArrangeTarget } from "./arrange-drop-policy";
import type { ArrangeDropData } from "./arrange-types";

interface ArrangeDropTargetOptions<T extends HTMLElement> {
  ref: RefObject<T | null>;
  roots: InfLocation[];
  locationId: LocationShortcode | null;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
}

/** Registers the common drop target behavior and exposes its hover state. */
export function useArrangeDropTarget<T extends HTMLElement>({
  ref,
  roots,
  locationId,
  onDragEnter,
  onDragLeave,
  onDrop,
}: ArrangeDropTargetOptions<T>): boolean {
  const [isOver, setIsOver] = useState(false);
  const callbacks = useRef({ onDragEnter, onDragLeave, onDrop });
  callbacks.current = { onDragEnter, onDragLeave, onDrop };

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      getData: (): ArrangeDropData & Record<string, unknown> => ({
        arrangeTarget: true,
        locationId,
      }),
      canDrop: ({ source }) =>
        canDropOnArrangeTarget(roots, locationId, source.data),
      onDragEnter: () => {
        setIsOver(true);
        callbacks.current.onDragEnter?.();
      },
      onDragLeave: () => {
        setIsOver(false);
        callbacks.current.onDragLeave?.();
      },
      onDrop: () => {
        setIsOver(false);
        callbacks.current.onDrop?.();
      },
    });
  }, [locationId, ref, roots]);

  return isOver;
}
