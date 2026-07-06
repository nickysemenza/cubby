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
  applyImageOrder,
  associatePendingImages,
  batchUpdateWithCaseWhen,
  findOrCreate,
  insertAndReturn,
  nextImageSortOrder,
  updateAndReturn,
  updateLiveAndReturn,
} from "./crud";
// Query helpers
export {
  assertNoDependents,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  isNotDeleted,
  lockAndValidateForDelete,
  notDeleted,
} from "./query";
// Relation loaders
export { imageOrder, relations } from "./relations";
export type { RowWithOptionalAliases } from "./transform";
// Transform helpers
export {
  buildPartialUpdateValues,
  mapImages,
  mapRelation,
  parseInventoryAmount,
} from "./transform";
