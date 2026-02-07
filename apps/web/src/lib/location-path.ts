/**
 * Location path utilities.
 */

import type { LocationType } from "@cubby/schemas/location";

/**
 * Get the default location type for a given depth in the hierarchy.
 * Root (depth 0) = "room", all children = "shelf"
 */
export const getDefaultLocationType = (depth: number): LocationType =>
  depth === 0 ? "room" : "shelf";
