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
// CSV operations (existing files)
export { getLocationRowDifferences } from "./csv-comparison";
export { exportLocationsToCSV } from "./csv-export";
export { importLocationsFromCSV } from "./csv-import";
// Helpers
export {
  buildLocationWithChildren,
  dbLocationToAPI,
  dbLocationToAPIWithChildren,
} from "./helpers";
export type {
  LocationDeepDB,
  LocationFilters,
  LocationImportData,
  LocationWithParentChild,
} from "./internal-types";
// Lookup operations
export {
  findLocationByName,
  findLocationByShortcode,
  findOrCreateLocationByName,
  getLocationByShortcode,
  getRecentlyActiveLocations,
} from "./lookup";
// Tree and hierarchy operations
export {
  buildLocationTree,
  buildLocationTypeCount,
  touchLastBulkInventory,
  updateLocationFromImport,
} from "./tree";
// Types (CSV export types are in types.ts, internal types in internal-types.ts)
export type { LocationCSVExportRow } from "./types";
