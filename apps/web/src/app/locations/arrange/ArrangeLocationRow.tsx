import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useDraggable } from "@dnd-kit/core";
import { Focus, GripVertical } from "lucide-react";
import { useEffect, useRef } from "react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import { resolveLocationPrimaryVisual } from "~/app/_components/locations/location-visual-resolver";
import { Row } from "~/components/layout";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { ArrangeMoveTo } from "./ArrangeMoveTo";
import { ArrangeThumb } from "./ArrangeThumb";
import { parentIdOf } from "./arrange-tree-utils";
import type { LocationDragData } from "./arrange-types";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

/** Hover-to-drill delay: long enough to avoid firing on a pass-through drag. */
const SPRING_LOAD_MS = 700;

interface ArrangeLocationRowProps {
  node: InfLocation;
  /** Full forest — needed for `parentIdOf`/`isValidLocationDrop` (cycle checks). */
  roots: InfLocation[];
  /** Visual indentation depth, forwarded to `LocationTreeRow`. */
  depth: number;
  onDrill: (id: LocationShortcode) => void;
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
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } =
    useDraggable({
      id: `arrange-location:${node.id}`,
      data: {
        arrangeDrag: "location",
        locationId: node.id,
        parentId: parentIdOf(roots, node.id),
      } satisfies LocationDragData,
    });
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always call the latest onDrill without re-registering the drop target.
  const onDrillRef = useRef(onDrill);
  onDrillRef.current = onDrill;

  const hasChildren = (node.children?.length ?? 0) > 0;

  const clearSpringTimer = () => {
    if (springTimer.current !== null) {
      clearTimeout(springTimer.current);
      springTimer.current = null;
    }
  };

  const { setNodeRef: setDropNodeRef, isOver } = useArrangeDropTarget({
    roots,
    locationId: node.id,
    onDragEnter: () => {
      if (hasChildren && springTimer.current === null) {
        springTimer.current = setTimeout(() => {
          onDrillRef.current(node.id);
        }, SPRING_LOAD_MS);
      }
    },
    onDragLeave: clearSpringTimer,
    onDrop: clearSpringTimer,
  });

  useEffect(
    () => () => {
      if (springTimer.current !== null) clearTimeout(springTimer.current);
    },
    [],
  );

  const itemCount =
    node.totalItemCount ??
    node.directItemCount ??
    node.inventoryItems?.length ??
    0;
  const childCount = node.childCount ?? node.children?.length ?? 0;
  const cover = resolveLocationPrimaryVisual(node).image;

  return (
    <LocationTreeRow
      ref={(element) => {
        setNodeRef(element);
        setDropNodeRef(element);
      }}
      location={node}
      depth={depth}
      active={isOver}
      faded={isDragging}
      primaryMeta={`${itemCount} item${itemCount === 1 ? "" : "s"}`}
      secondaryMeta={
        childCount > 0
          ? `${childCount} sublocation${childCount === 1 ? "" : "s"}`
          : undefined
      }
      icon={
        <ArrangeThumb
          images={cover ? [cover] : []}
          alt={node.name}
          size={32}
          fill
          // -my cancels the row's own py so the cover is full-bleed.
          className="-my-1"
          fallback={
            <LocationIcon type={node.type} product={node.product} size={14} />
          }
          to="/locations/$shortcode"
          shortcode={node.id}
        />
      }
      trailing={
        <Row align="center" gap="tight" className="shrink-0">
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={`Drag ${node.name}`}
            className="touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            {...listeners}
            {...attributes}
          >
            <GripVertical className="size-3.5" />
          </button>
          {hasChildren && (
            // Zooms the tree to this node (it sets the breadcrumb root), so the
            // icon must not read as download or as expand/collapse.
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Zoom into ${node.name}`}
                    onClick={() => onDrill(node.id)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <Focus className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Zoom into {node.name}</TooltipContent>
            </Tooltip>
          )}
          <ArrangeMoveTo
            target={{
              kind: "location",
              locationId: node.id,
              name: node.name,
              roots,
            }}
          />
        </Row>
      }
      className={cn("select-none rounded py-1", isDragging && "opacity-40")}
    />
  );
}
