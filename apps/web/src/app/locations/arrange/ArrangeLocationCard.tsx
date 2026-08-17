import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { InfLocation } from "@cubby/schemas/location";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row } from "~/components/layout";
import { cn } from "~/lib/utils";
import { ArrangeMoveTo } from "./ArrangeMoveTo";
import { ArrangeThumb } from "./ArrangeThumb";
import {
  isValidItemDrop,
  isValidLocationDrop,
  locationItemCount,
  parentIdOf,
} from "./arrange-tree-utils";
import {
  type ArrangeDropData,
  asDragData,
  type LocationDragData,
} from "./arrange-types";

interface ArrangeLocationCardProps {
  node: InfLocation;
  roots: InfLocation[];
  /** True when this card's location is the one currently opened in the next column. */
  active: boolean;
  onOpen: () => void;
}

/**
 * A location as a Board card: draggable (to reparent), a drop target (drop
 * onto it to move something INTO that location without opening it), and
 * clickable (opens its children as the next Miller column). The "Move to…"
 * trigger sits OUTSIDE the card element on purpose — native drag doesn't start
 * from inside an interactive child, so nesting it would eat the card's own
 * drag surface. The cover tile is outside for a second reason: it links to the
 * location's detail page, and an <a> nested in a <button> is invalid HTML.
 */
export function ArrangeLocationCard({
  node,
  roots,
  active,
  onOpen,
}: ArrangeLocationCardProps) {
  const ref = useRef<HTMLButtonElement>(null);
  // The drop target is the whole bordered card, not just the drag handle, so
  // the cover-link gutter still accepts a drop.
  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);

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

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      getData: (): ArrangeDropData & Record<string, unknown> => ({
        arrangeTarget: true,
        locationId: node.id,
      }),
      canDrop: ({ source }) => {
        const drag = asDragData(source.data);
        if (!drag) return false;
        if (drag.arrangeDrag === "location")
          return isValidLocationDrop(roots, drag.locationId, node.id);
        return isValidItemDrop(roots, drag.sourceLocationId, node.id);
      },
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [node.id, roots]);

  const count = locationItemCount(node);
  const childCount = node.childCount ?? node.children?.length ?? 0;

  return (
    <Row align="center" gap="tight" className="min-w-0">
      <Row
        ref={cardRef}
        align="center"
        gap="tight"
        className={cn(
          "min-w-0 flex-1 rounded border px-2 py-1.5" /* tight: card */,
          active
            ? "border-primary bg-primary/10"
            : "border-[var(--border)] bg-background hover:bg-muted/50",
          isOver && "border-primary bg-primary/15",
          dragging && "opacity-40",
        )}
      >
        <ArrangeThumb
          images={node.images}
          alt={node.name}
          size={32}
          fill
          // -my cancels the card's own py so the cover is full-bleed.
          className="-my-1.5" /* tight: matches the card's py-1.5 */
          fallback={<LocationIcon type={node.type} product={null} size={14} />}
          to="/locations/$shortcode"
          shortcode={node.id}
        />
        <button
          ref={ref}
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 text-left active:cursor-grabbing"
        >
          <span
            className="min-w-0 flex-1 truncate font-medium text-sm"
            title={node.name}
          >
            {node.name}
          </span>
          {count > 0 && (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
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
