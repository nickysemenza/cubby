import type { Amount } from "@cubby/schemas/codec";
import type {
  InventoryShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";

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

export function asDragData(
  data: Record<string | symbol, unknown>,
): ArrangeDragData | null {
  if (data.arrangeDrag === "location") return data as LocationDragData;
  if (data.arrangeDrag === "item") return data as ItemDragData;
  return null;
}

export function asDropData(
  data: Record<string | symbol, unknown>,
): ArrangeDropData | null {
  return data.arrangeTarget === true ? (data as ArrangeDropData) : null;
}
