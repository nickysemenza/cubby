/**
 * Database helpers module.
 *
 * Re-exports all database helper functions.
 * Import from this file for all database operations.
 */

// Core database access
export { getDb, unwrapDb, withTransaction } from "./core";
// CRUD operations
export {
  associatePendingImages,
  batchUpdateWithCaseWhen,
  findOrCreate,
  insertAndReturn,
  updateAndReturn,
} from "./crud";
// Query helpers
export {
  buildOrderBy,
  buildSearchConditions,
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
