/**
 * Database helpers module.
 *
 * Re-exports all database helper functions.
 * Import from this file for all database operations.
 */

// Batch lookup helpers
export {
  batchFindIngredients,
  batchFindInventoryEntries,
  batchFindLocations,
  batchFindProductsByIds,
  batchFindProductsByNameManufacturer,
  batchFindProductsByUPC,
  createProductKey,
  type InventoryLookupMap,
  type LocationLookupMap,
  type ProductLookupMap,
} from "./batch-lookups";
// Core database access
export { getDb, unwrapDb, withTransaction } from "./core";
// CRUD operations
export {
  associatePendingImages,
  batchInsert,
  batchUpsertInventory,
  insertAndReturn,
  insertAndReturnDb,
  updateAndReturn,
  updateAndReturnDb,
} from "./crud";
// Query helpers
export {
  buildOrderBy,
  executeListQueryWithCount,
  formatSearchTerm,
  lockAndValidateForDelete,
  notDeleted,
} from "./query";
// Relation loaders
export { relations } from "./relations";
// Transform helpers
export {
  addProductSourceMetadata,
  buildPartialUpdateValues,
  extractImagesFromJoinTable,
  mapRelation,
  parseInventoryAmount,
} from "./transform";
