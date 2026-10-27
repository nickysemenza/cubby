import type { LocationType } from "@cubby/schemas/location";
import pluralize from "pluralize";

/** A homogeneous direct-child set earns a useful physical label. */
export function locationChildGroupLabel(
  types: readonly (LocationType | null)[],
): string {
  if (types.length === 0) return "Locations";
  const [first] = types;
  if (first == null || types.some((type) => type !== first))
    return "Compartments";
  return pluralize(first, types.length);
}
