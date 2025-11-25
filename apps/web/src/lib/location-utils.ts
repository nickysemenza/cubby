import { type InfLocation } from "~/schemas/location";

/**
 * Flatten a hierarchical tree of locations into a flat array.
 * Recursively processes all children at each level.
 *
 * @param locations - Array of locations with nested children
 * @returns Flat array of all locations in the tree
 */
export const flattenLocations = (locations: InfLocation[]): InfLocation[] => {
  const result: InfLocation[] = [];
  for (const loc of locations) {
    result.push(loc);
    if (loc.children) {
      result.push(...flattenLocations(loc.children));
    }
  }
  return result;
};
