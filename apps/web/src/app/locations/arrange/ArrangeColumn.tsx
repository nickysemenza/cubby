import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";

import { LocationIcon } from "~/app/_components/locations/location-icons";
import { cn } from "~/lib/utils";

import { ArrangeItemChip } from "./ArrangeItemChip";
import { ArrangeLocationCard } from "./ArrangeLocationCard";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

interface ArrangeColumnProps {
  /** The location this column represents (its cards are this location's children). */
  locationId: LocationShortcode | null;
  /** Header location, or null while the hierarchy is unavailable. */
  headerLocation: InfLocation | null;
  /** Child-location cards to render. */
  nodes: InfLocation[];
  /** The header location's own inventory items (loose items at this location). */
  items: InventoryItemForTree[];
  /** Which child is currently opened as the next column (for active highlight). */
  activeChildId: LocationShortcode | null;
  roots: InfLocation[];
  onOpenChild: (id: LocationShortcode) => void;
  /** The pinned Unknown staging column (dashed styling). */
  pinned?: boolean;
}

/**
 * One Miller column. The whole body is a drop target for the column's location
 * (drop = move into it); child-location cards nested inside are their own
 * innermost drop targets (drop = move into that child).
 */
export function ArrangeColumn({
  locationId,
  headerLocation,
  nodes,
  items,
  activeChildId,
  roots,
  onOpenChild,
  pinned = false,
}: ArrangeColumnProps) {
  const { setNodeRef, isOver } = useArrangeDropTarget({ roots, locationId });

  const isEmpty = nodes.length === 0 && items.length === 0;
  const locationName = headerLocation?.name ?? "Home";

  return (
    <section
      aria-label={`${locationName} column`}
      data-arrange-main-column={pinned ? undefined : ""}
      className={cn(
        "flex w-[calc(100vw-2rem)] shrink-0 snap-start flex-col border sm:w-72",
        pinned
          ? "border-dashed border-[var(--border-strong)]"
          : "border-[var(--border)]",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-2">
        {pinned ? (
          <QuestionIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : headerLocation ? (
          <LocationIcon type={headerLocation.type} product={null} size={16} />
        ) : (
          <HouseIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {headerLocation?.name ?? "Home"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {nodes.length + items.length}
        </span>
      </div>

      <fieldset
        ref={setNodeRef}
        aria-label={`${locationName} contents drop target`}
        className={cn(
          "flex max-h-[calc(100dvh-14rem)] min-w-0 flex-1 flex-col gap-1 overflow-y-auto p-2" /* tight: dense card list */,
          isOver && "bg-primary/10",
        )}
      >
        {nodes.map((child) => (
          <ArrangeLocationCard
            key={child.id}
            node={child}
            roots={roots}
            active={child.id === activeChildId}
            onOpen={() => onOpenChild(child.id)}
          />
        ))}
        {items.map((item) =>
          locationId ? (
            <ArrangeItemChip
              key={item.id}
              item={item}
              sourceLocationId={locationId}
              roots={roots}
            />
          ) : null,
        )}
        {isEmpty && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {pinned
              ? "Drop anything here to stage it, then open another column and drag it back out."
              : "Nothing here"}
          </p>
        )}
      </fieldset>
    </section>
  );
}
