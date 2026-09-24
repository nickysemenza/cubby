import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { useDraggable } from "@dnd-kit/core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { useHydratedProductImages } from "~/app/_components/products/product-image-summaries";
import { cn } from "~/lib/utils";

import type { ItemDragData } from "./arrange-types";
import { ArrangeMoveTo } from "./ArrangeMoveTo";
import { ArrangeThumb } from "./ArrangeThumb";

interface ArrangeItemChipProps {
  item: InventoryItemForTree;
  /** The location this item currently lives at (the move's source). */
  sourceLocationId: LocationShortcode;
  /** Needed so Move to… can exclude the Home structural location. */
  roots: InfLocation[];
}

/**
 * A draggable inventory item — used by both the Board and Tree views. Dragging
 * carries the full `amount` so a drop performs a whole-entry move; the
 * "Move to…" picker carries the same payload for pointer-free moves.
 */
export function ArrangeItemChip({
  item,
  sourceLocationId,
  roots,
}: ArrangeItemChipProps) {
  const images = useHydratedProductImages(item.productId);

  const drag = useMemo<ItemDragData>(
    () => ({
      arrangeDrag: "item",
      inventoryEntryId: item.id,
      amount: item.amount,
      sourceLocationId,
    }),
    [item.id, item.amount, sourceLocationId],
  );

  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } =
    useDraggable({
      id: `arrange-item:${item.id}`,
      data: drag,
    });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center gap-1.5 rounded border border-[var(--border)] bg-background px-2 py-1 text-xs" /* tight: chip */,
        isDragging && "opacity-40",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Drag ${item.productName}`}
        className="touch-none rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary max-md:min-h-11 max-md:min-w-11"
        {...listeners}
        {...attributes}
      >
        <DotsSixVerticalIcon className="size-3" />
      </button>
      <ArrangeThumb
        images={images}
        alt={item.productName}
        size={32}
        fill
        // -my cancels the chip's own py so the cover is full-bleed. The name is
        // line-clamped to two lines, so the tile follows a two-line chip up.
        className="-my-1"
        fallback={<PackageIcon className="size-3" />}
        to="/products/$shortcode"
        shortcode={item.productId}
      />
      {/* Two lines, not one: board columns are narrow enough that a single
          truncated line cut most product names to ~12 characters. Linked
          because a rendered entity name is never plain truncated text; see
          `draggable={false}` in ArrangeThumb for why the anchor opts out. */}
      <Link
        to="/products/$shortcode"
        params={{ shortcode: item.productId }}
        draggable={false}
        title={item.productName}
        className="line-clamp-2 min-w-0 flex-1 hover:underline"
      >
        {item.productName}
      </Link>
      <span className="shrink-0 text-muted-foreground">
        {tryFormatAmount(item.amount)}
      </span>
      <ArrangeMoveTo
        target={{ kind: "item", drag, name: item.productName, roots }}
      />
    </div>
  );
}
