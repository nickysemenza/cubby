import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useEffect, useRef } from "react";
import { match } from "ts-pattern";
import { isValidItemDrop, isValidLocationDrop } from "./arrange-tree-utils";
import { asDragData, asDropData, type ItemDragData } from "./arrange-types";

interface UseArrangeDndArgs {
  /** Current tree roots — read live so the monitor never needs re-registering. */
  roots: InfLocation[];
  moveLocation: (
    dragId: LocationShortcode,
    targetId: LocationShortcode | null,
  ) => void;
  moveItem: (drag: ItemDragData, targetLocationId: LocationShortcode) => void;
}

/**
 * Registers the single `monitorForElements` that turns a valid drop into a
 * mutation. Each drop target's own `canDrop` already gates validity for the
 * cursor/feedback; this re-checks with the live tree as a defensive backstop
 * before firing (targets and tree can drift between hover and drop).
 */
export function useArrangeDnd({
  roots,
  moveLocation,
  moveItem,
}: UseArrangeDndArgs): void {
  const rootsRef = useRef(roots);
  const moveLocationRef = useRef(moveLocation);
  const moveItemRef = useRef(moveItem);
  rootsRef.current = roots;
  moveLocationRef.current = moveLocation;
  moveItemRef.current = moveItem;

  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const drag = asDragData(source.data);
        if (!drag) return;
        // Innermost drop target under the pointer.
        const target = location.current.dropTargets[0];
        if (!target) return;
        const drop = asDropData(target.data);
        if (!drop) return;

        match(drag)
          .with({ arrangeDrag: "location" }, (d) => {
            if (
              isValidLocationDrop(
                rootsRef.current,
                d.locationId,
                drop.locationId,
              )
            ) {
              moveLocationRef.current(d.locationId, drop.locationId);
            }
          })
          .with({ arrangeDrag: "item" }, (d) => {
            // Items require a real location target (never "Home").
            if (
              drop.locationId !== null &&
              isValidItemDrop(d.sourceLocationId, drop.locationId)
            ) {
              moveItemRef.current(d, drop.locationId);
            }
          })
          .exhaustive();
      },
    });
  }, []);
}
