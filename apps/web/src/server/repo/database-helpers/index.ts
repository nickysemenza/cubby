/**
 * Database helpers module.
 *
 * Re-exports all database helper functions.
 * Import from this file for all database operations.
 */

// Core database access
export {
  getDb,
  isTransaction,
  unwrapDb,
  withTransaction,
  withTransactionOn,
} from "./core";
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
// Dependency-edge replacement + read (project/task blockedByIds)
export { dependencyIdsFor, replaceDependencyEdges } from "./dependency-edges";
// Query helpers
export {
  assertNoDependents,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  idSetPresence,
  isNotDeleted,
  lockAndValidateForDelete,
  matchesStringValues,
  notDeleted,
  presenceCondition,
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
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "./transform";
