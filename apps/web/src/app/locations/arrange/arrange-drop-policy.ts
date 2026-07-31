import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { isValidItemDrop, isValidLocationDrop } from "./arrange-tree-utils";
import { asDragData } from "./arrange-types";

/** Shared policy for every breadcrumb, row, and column drop surface. */
export function canDropOnArrangeTarget(
  roots: InfLocation[],
  targetLocationId: LocationShortcode | null,
  sourceData: Record<string | symbol, unknown>,
): boolean {
  const drag = asDragData(sourceData);
  if (!drag) return false;
  if (drag.arrangeDrag === "location") {
    return isValidLocationDrop(roots, drag.locationId, targetLocationId);
  }
  return (
    targetLocationId !== null &&
    isValidItemDrop(drag.sourceLocationId, targetLocationId)
  );
}
