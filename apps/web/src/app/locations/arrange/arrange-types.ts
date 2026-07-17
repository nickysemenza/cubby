import type { Amount } from "@cubby/schemas/codec";
import type { InventoryId, LocationId } from "@cubby/schemas/identifiers";

/**
 * pragmatic-drag-and-drop payloads for the arrange surface. Both the Board and
 * Tree views produce the SAME drag/drop data shapes, so the monitor + validity
 * logic is shared. Data is `Record<string | symbol, unknown>` on the wire; the
 * `as*`/`is*` guards below narrow it back.
 */

export type LocationDragData = {
  arrangeDrag: "location";
  locationId: LocationId;
  /** Current parent id, or null for a top-level location. Lets us skip no-ops. */
  parentId: LocationId | null;
};

export type ItemDragData = {
  arrangeDrag: "item";
  inventoryEntryId: InventoryId;
  amount: Amount;
  sourceLocationId: LocationId;
};

export type ArrangeDragData = LocationDragData | ItemDragData;

/** A location drop target. `locationId: null` is the "Home" (top-level) target. */
export type ArrangeDropData = {
  arrangeTarget: true;
  locationId: LocationId | null;
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
