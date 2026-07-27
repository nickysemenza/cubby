/**
 * Location repository — public API barrel.
 *
 * A Location is a node in the self-referential storage tree
 * (house → room → shelf → bin, via `parentId`); `type` is free text and depth is
 * whatever the parent chain produces. See
 * {@link file://../../../../../docs/terminology.md}.
 * Import location operations from `~/server/repo/location` (this barrel).
 *
 *   CRUD   → `crud.ts`    (create / update / delete + by-id read, list, and the
 *                          AI-description backfill helpers)
 *   LOOKUP → `lookup.ts`  (find-or-create by name, by-shortcode reads, recently
 *                          active)
 *   TREE   → `tree.ts`    (buildLocationTree / type counts derived read-time;
 *                          there is no materialized path column)
 *
 * Sibling relationships: holds `inventory` entries (`inventoryEntry.locationId`).
 * `helpers.ts` / `internal-types.ts` are internal and not re-exported.
 */

// CRUD operations
export {
  createLocation,
  deleteLocations,
  ensureGlobalUnknownLocation,
  findLocationsNeedingAiDescription,
  getChildCountsByLocationIds,
  getLocationById,
  isGlobalUnknownLocation,
  locationList,
  updateLocation,
  updateLocationAiDescription,
} from "./crud";
// Lookup operations
export {
  findOrCreateLocationByName,
  getLocationByShortcode,
  getLocationsByShortcodes,
  getRecentlyActiveLocations,
} from "./lookup";
// Tree and hierarchy operations
export { buildLocationTree, buildLocationTypeCount } from "./tree";
// Valuation rollup persistence
export {
  getLocationValuationInputs,
  writeLocationValuations,
} from "./valuation";
