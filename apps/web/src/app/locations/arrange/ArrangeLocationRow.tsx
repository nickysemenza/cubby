import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { ArrowDownToLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import {
  isValidItemDrop,
  isValidLocationDrop,
  parentIdOf,
} from "./arrange-tree-utils";
import {
  type ArrangeDropData,
  asDragData,
  type LocationDragData,
} from "./arrange-types";

/** Hover-to-drill delay: long enough to avoid firing on a pass-through drag. */
const SPRING_LOAD_MS = 700;

interface ArrangeLocationRowProps {
  node: InfLocation;
  /** Full forest — needed for `parentIdOf`/`isValidLocationDrop` (cycle checks). */
  roots: InfLocation[];
  /** Visual indentation depth, forwarded to `LocationTreeRow`. */
  depth: number;
  onDrill: (id: LocationId) => void;
}

/**
 * One row in the arrange tree: a location that is BOTH draggable (to reparent
 * it elsewhere) and a drop target (so other locations/items can be dropped
 * onto it). Hovering a drag over a row with children for `SPRING_LOAD_MS`
 * "spring-loads" — it drills into that row so the user can drop deeper
 * without letting go first.
 */
export function ArrangeLocationRow({
  node,
  roots,
  depth,
  onDrill,
}: ArrangeLocationRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always call the latest onDrill without re-registering the drop target.
  const onDrillRef = useRef(onDrill);
  onDrillRef.current = onDrill;

  const hasChildren = (node.children?.length ?? 0) > 0;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const clearSpringTimer = () => {
      if (springTimer.current !== null) {
        clearTimeout(springTimer.current);
        springTimer.current = null;
      }
    };

    const cleanupDraggable = draggable({
      element,
      getInitialData: (): LocationDragData & Record<string, unknown> => ({
        arrangeDrag: "location",
        locationId: node.id,
        parentId: parentIdOf(roots, node.id),
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });

    const cleanupDropTarget = dropTargetForElements({
      element,
      getData: (): ArrangeDropData & Record<string, unknown> => ({
        arrangeTarget: true,
        locationId: node.id,
      }),
      canDrop: ({ source }) => {
        const d = asDragData(source.data);
        if (!d) return false;
        if (d.arrangeDrag === "location") {
          return isValidLocationDrop(roots, d.locationId, node.id);
        }
        return isValidItemDrop(d.sourceLocationId, node.id);
      },
      onDragEnter: () => {
        setIsOver(true);
        if (hasChildren && springTimer.current === null) {
          springTimer.current = setTimeout(() => {
            onDrillRef.current(node.id);
          }, SPRING_LOAD_MS);
        }
      },
      onDragLeave: () => {
        setIsOver(false);
        clearSpringTimer();
      },
      onDrop: () => {
        setIsOver(false);
        clearSpringTimer();
      },
    });

    return () => {
      cleanupDraggable();
      cleanupDropTarget();
      clearSpringTimer();
    };
  }, [node.id, roots, hasChildren]);

  const itemCount =
    node.totalItemCount ??
    node.directItemCount ??
    node.inventoryItems?.length ??
    0;
  const childCount = node.childCount ?? node.children?.length ?? 0;

  return (
    <LocationTreeRow
      ref={ref}
      location={node}
      depth={depth}
      active={isOver}
      faded={dragging}
      primaryMeta={`${itemCount} item${itemCount === 1 ? "" : "s"}`}
      secondaryMeta={
        childCount > 0
          ? `${childCount} sublocation${childCount === 1 ? "" : "s"}`
          : undefined
      }
      trailing={
        hasChildren ? (
          <button
            type="button"
            aria-label={`Drill into ${node.name}`}
            onClick={() => onDrill(node.id)}
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowDownToLine className="size-3.5" />
          </button>
        ) : undefined
      }
      className="cursor-grab select-none rounded py-1 active:cursor-grabbing"
    />
  );
}
