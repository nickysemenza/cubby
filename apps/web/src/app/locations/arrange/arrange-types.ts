import type { Amount } from "@cubby/schemas/codec";
import type {
  InventoryShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";

/**
 * pragmatic-drag-and-drop payloads for the arrange surface. Both the Board and
 * Tree views produce the SAME drag/drop data shapes, so the monitor + validity
 * logic is shared. Data is `Record<string | symbol, unknown>` on the wire; the
 * `as*`/`is*` guards below narrow it back.
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
