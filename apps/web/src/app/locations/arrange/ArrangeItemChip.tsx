import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InventoryItemForTree } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { GripVertical, Package } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { useHydratedProductImages } from "~/app/_components/products/product-image-summaries";
import { cn } from "~/lib/utils";
import { ArrangeMoveTo } from "./ArrangeMoveTo";
import { ArrangeThumb } from "./ArrangeThumb";
import type { ItemDragData } from "./arrange-types";

interface ArrangeItemChipProps {
  item: InventoryItemForTree;
  /** The location this item currently lives at (the move's source). */
  sourceLocationId: LocationShortcode;
}

/**
 * A draggable inventory item — used by both the Board and Tree views. Dragging
 * carries the full `amount` so a drop performs a whole-entry move; the
 * "Move to…" picker carries the same payload for pointer-free moves.
 */
export function ArrangeItemChip({
  item,
  sourceLocationId,
}: ArrangeItemChipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
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

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      getInitialData: (): ItemDragData & Record<string, unknown> => ({
        ...drag,
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [drag]);

  return (
    <div
      ref={ref}
      className={cn(
        "flex cursor-grab items-center gap-1.5 rounded border border-[var(--border)] bg-background px-2 py-1 text-xs active:cursor-grabbing" /* tight: chip */,
        dragging && "opacity-40",
      )}
    >
      <GripVertical className="size-3 shrink-0 text-muted-foreground" />
      <ArrangeThumb
        images={images}
        alt={item.productName}
        size={24}
        fallback={<Package className="size-3" />}
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
      <ArrangeMoveTo target={{ kind: "item", drag, name: item.productName }} />
    </div>
  );
}
