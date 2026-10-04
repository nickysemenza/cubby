import type { InfLocation, LocationType } from "@cubby/schemas/location";
import pluralize from "pluralize";

/** A homogeneous direct-child set earns a useful physical label. */
export function locationChildGroupLabel(
  children: ReadonlyArray<Pick<InfLocation, "type">>,
): string {
  if (children.length === 0) return "Locations";
  const types = new Set(
    children
      .map((child) => child.type)
      .filter((type): type is LocationType => type != null),
  );
  if (types.size !== 1 || children.some((child) => child.type == null)) {
    return "Compartments";
  }
  const [type] = types;
  return pluralize(type ?? "compartment", children.length);
}
