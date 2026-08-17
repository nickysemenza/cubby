import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { Focus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import { Row } from "~/components/layout";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
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
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
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

  const isOver = useArrangeDropTarget({
    ref,
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

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      getInitialData: (): LocationDragData & Record<string, unknown> => ({
        arrangeDrag: "location",
        locationId: node.id,
        parentId: parentIdOf(roots, node.id),
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [node.id, roots]);

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
      icon={
        <ArrangeThumb
          images={node.images}
          alt={node.name}
          size={32}
          fill
          // -my cancels the row's own py so the cover is full-bleed.
          className="-my-1"
          fallback={<LocationIcon type={node.type} product={null} size={14} />}
          to="/locations/$shortcode"
          shortcode={node.id}
        />
      }
      trailing={
        <Row align="center" gap="tight" className="shrink-0">
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
      className="cursor-grab select-none rounded py-1 active:cursor-grabbing"
    />
  );
}
