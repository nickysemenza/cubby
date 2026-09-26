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
 *   TREE   → `tree.ts`    (buildLocationTree downward / loadLocationAncestors
 *                          upward, both derived read-time; there is no
 *                          materialized path column)
 *
 * Sibling relationships: holds `inventory` entries (`inventoryEntry.locationId`).
 * `helpers.ts` / `internal-types.ts` are internal and not re-exported.
 */

// CRUD operations
export {
  bulkReparentLocations,
  createLocation,
  deleteLocations,
  ensureGlobalUnknownLocation,
  findLocationsNeedingAiDescription,
  getLocationById,
  getLocationCoverImageUrlsByLocationIds,
  isGlobalUnknownLocation,
  locationList,
  locationSearch,
  updateLocation,
  updateLocationAiDescription,
} from "./crud";
// Lookup operations
export {
  findOrCreateLocationByName,
  getLocationPutAwayCandidates,
  getLocationsByShortcodes,
  type LocationPutAwayCandidate,
} from "./lookup";
export { reparentLocationsInBulk } from "./reparent";
// Tree and hierarchy operations
// `loadLocationAncestors` / `wouldCreateParentCycle` stay module-internal —
// they're inputs to the reads below, not operations of their own.
//
// `loadLocationAncestors` has one caller outside this module
// (product/analytics.ts's tag-sibling storage rollup), which deep-imports
// `./tree` rather than going through this barrel: `./crud` imports
// product/pricing, so a product module importing this barrel closes an import
// cycle. Same reason crud.ts deep-imports `product/pricing` instead of the
// product barrel.
export { buildLocationTree, getLocationInventoryBreakdown } from "./tree";
// Valuation — computed on read, no persisted rollup
export { getLocationValuationSummary } from "./valuation";
