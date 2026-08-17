/**
 * Location path utilities.
 */

import type { LocationType } from "@cubby/schemas/location";

/**
 * Get the default location type for a given depth in the hierarchy.
 * Root (depth 0) = "house", its children = "room", later levels = "shelf".
 */
export const getDefaultLocationType = (depth: number): LocationType =>
  depth === 0 ? "house" : depth === 1 ? "room" : "shelf";
