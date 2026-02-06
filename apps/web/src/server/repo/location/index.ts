/**
 * Location repository module.
 *
 * Re-exports all location-related repository functions.
 * Import from this file for all location operations.
 */

// CRUD operations
export {
  createLocation,
  deleteLocations,
  getChildCountsByLocationIds,
  getLocationById,
  locationList,
  updateLocation,
} from "./crud";
// Helpers
export {
  buildLocationWithChildren,
  dbLocationToAPI,
  dbLocationToAPIWithChildren,
} from "./helpers";
export type {
  LocationDeepDB,
  LocationFilters,
  LocationWithParentChild,
} from "./internal-types";
// Lookup operations
export {
  findLocationByName,
  findLocationByShortcode,
  findOrCreateLocationByName,
  getLocationByShortcode,
  getLocationsByShortcodes,
  getRecentlyActiveLocations,
} from "./lookup";
// Tree and hierarchy operations
export {
  buildLocationTree,
  buildLocationTypeCount,
  touchLastBulkInventory,
} from "./tree";
