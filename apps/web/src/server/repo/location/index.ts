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
  findLocationsNeedingAiDescription,
  getChildCountsByLocationIds,
  getLocationById,
  locationList,
  updateLocation,
  updateLocationAiDescription,
} from "./crud";
export type {
  LocationDeepDB,
  LocationFilters,
  LocationWithParentChild,
} from "./internal-types";
// Lookup operations
export {
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
