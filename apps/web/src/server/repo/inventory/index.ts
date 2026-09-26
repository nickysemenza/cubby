/**
 * Inventory repository — public API barrel.
 *
 * An InventoryEntry is a quantity of one Product at one Location (unique per
 * `(productId, locationId)`); see {@link file://../../../../../docs/terminology.md}.
 * Import inventory operations from `~/server/repo/inventory` (this barrel).
 *
 *   CRUD   → `crud.ts`  (create / update / delete + the product/location-scoped
 *                        reads and count rollups the inventory views need)
 *   BULK   → `bulk.ts`  (bulk move + bulk add/update across many entries, used
 *                        by the mobile bulk-capture flow)
 *
 * Sibling relationships: depends on `product` (price → `valuation`) and
 * `location` (where an entry lives); consumed by the inventory routers/services.
 * `helpers.ts` / `types.ts` are internal and intentionally not re-exported.
 */

// CRUD operations

// Bulk operations
export {
  addInventoryEntries,
  bulkMoveInventoryEntries,
  getInventoryLocationSnapshotToken,
  moveInventoryEntries,
  reconcileLocationSession,
} from "./bulk";
export {
  confirmInventoryExpenseBeneficiary,
  confirmInventoryOwnership,
  setInventoryOwnership,
} from "./ownership-mutations";
export {
  loadEffectiveInventoryOwnershipById,
  loadInheritedProductOwners,
} from "./ownership";
export {
  createInventoryEntry,
  deleteInventoryEntries,
  getInventoryByLocationIds,
  getInventoryEntryByShortcode,
  getInventoryForProducts,
  inventoryentryList,
} from "./crud";
export {
  getLiveStockRowsByIds,
  getProductStockRows,
  markInventoryEntryVerified,
} from "./scan";
