import { type Amount, amount } from "@cubby/schemas/codec";
import {
  type InventoryShortcode,
  inventoryShortcode,
  type LocationShortcode,
  locationShortcode,
} from "@cubby/schemas/identifiers";
import { z } from "zod";

/**
 * dnd-kit payloads for the arrange surface. Both views produce the same typed
 * drag/drop data, so collision and commit policy are shared.
 */

export type LocationDragData = {
  arrangeDrag: "location";
  locationId: LocationShortcode;
  /** Current parent id, or null only for Home. Lets us skip no-ops. */
  parentId: LocationShortcode | null;
};

export type ItemDragData = {
  arrangeDrag: "item";
  inventoryEntryId: InventoryShortcode;
  amount: Amount;
  sourceLocationId: LocationShortcode;
};

export type ArrangeDragData = LocationDragData | ItemDragData;

/** A location drop target. Null is reserved for an unavailable hierarchy. */
export type ArrangeDropData = {
  arrangeTarget: true;
  locationId: LocationShortcode | null;
};

const arrangeDragDataSchema = z.discriminatedUnion("arrangeDrag", [
  z.object({
    arrangeDrag: z.literal("location"),
    locationId: locationShortcode,
    parentId: locationShortcode.nullable(),
  }),
  z.object({
    arrangeDrag: z.literal("item"),
    inventoryEntryId: inventoryShortcode,
    amount,
    sourceLocationId: locationShortcode,
  }),
]);

const arrangeDropDataSchema = z.object({
  arrangeTarget: z.literal(true),
  locationId: locationShortcode.nullable(),
});

export function asDragData(
  data: Record<string | symbol, unknown>,
): ArrangeDragData | null {
  return arrangeDragDataSchema.safeParse(data).data ?? null;
}

export function asDropData(
  data: Record<string | symbol, unknown>,
): ArrangeDropData | null {
  return arrangeDropDataSchema.safeParse(data).data ?? null;
}
