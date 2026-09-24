import type { InfLocation } from "@cubby/schemas/location";
import { useDraggable } from "@dnd-kit/core";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DotsSixVerticalIcon as GripVertical } from "@phosphor-icons/react/dist/csr/DotsSixVertical";

import { LocationIcon } from "~/app/_components/locations/location-icons";
import { resolveLocationPrimaryVisual } from "~/app/_components/locations/location-visual-resolver";
import { Row } from "~/components/layout";
import { cn } from "~/lib/utils";

import { locationItemCount, parentIdOf } from "./arrange-tree-utils";
import type { LocationDragData } from "./arrange-types";
import { ArrangeMoveTo } from "./ArrangeMoveTo";
import { ArrangeThumb } from "./ArrangeThumb";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

interface ArrangeLocationCardProps {
  node: InfLocation;
  roots: InfLocation[];
  active: boolean;
  onOpen: () => void;
}

/** A board location with separate open, drag, detail, and Move To affordances. */
export function ArrangeLocationCard({
  node,
  roots,
  active,
  onOpen,
}: ArrangeLocationCardProps) {
  const dragData: LocationDragData = {
    arrangeDrag: "location",
    locationId: node.id,
    parentId: parentIdOf(roots, node.id),
  };
  const {
    setNodeRef: setDragNodeRef,
    setActivatorNodeRef,
    listeners,
    attributes,
    isDragging,
  } = useDraggable({ id: `arrange-location:${node.id}`, data: dragData });
  const { setNodeRef: setDropNodeRef, isOver } = useArrangeDropTarget({
    roots,
    locationId: node.id,
  });
  const count = locationItemCount(node);
  const childCount = node.childCount ?? node.children?.length ?? 0;
  const cover = resolveLocationPrimaryVisual(node).image;
  return (
    <Row align="center" gap="tight" className="min-w-0">
      <Row
        as="fieldset"
        ref={(element) => {
          setDragNodeRef(element);
          setDropNodeRef(element);
        }}
        aria-label={`${node.name} location drop target`}
        align="center"
        gap="tight"
        className={cn(
          "min-w-0 flex-1 rounded-none border px-2 py-1",
          active
            ? "border-primary bg-primary/10"
            : "border-[var(--border)] bg-background hover:bg-muted/50",
          isOver && "border-primary bg-primary/15",
          isDragging && "opacity-40",
        )}
      >
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Drag ${node.name}`}
          className="touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary max-md:min-h-11 max-md:min-w-11"
          {...listeners}
          {...attributes}
        >
          <GripVertical className="size-3.5" />
        </button>
        <ArrangeThumb
          images={cover ? [cover] : []}
          alt={node.name}
          size={32}
          fill
          className="-my-1"
          fallback={
            <LocationIcon type={node.type} product={node.product} size={14} />
          }
          to="/locations/$shortcode"
          shortcode={node.id}
        />
        <button
          type="button"
          onClick={onOpen}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left md:min-h-0"
        >
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={node.name}
          >
            {node.name}
          </span>
          {count > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
          {childCount > 0 && (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>
      </Row>
      <ArrangeMoveTo
        target={{
          kind: "location",
          locationId: node.id,
          name: node.name,
          roots,
        }}
      />
    </Row>
  );
}
