/**
 * Database helpers module.
 *
 * Re-exports all database helper functions.
 * Import from this file for all database operations.
 */

// Core database access
export {
  databaseForTransaction,
  getDb,
  isTransaction,
  unwrapDb,
  withTransaction,
  withTransactionDatabase,
  withTransactionOn,
} from "./core";
// CRUD operations
export {
  applyImageOrder,
  associatePendingImages,
  batchUpdateWithCaseWhen,
  FindOrCreateConflictError,
  findOrCreate,
  imageJoinBindings,
  insertAndReturn,
  nextImageSortOrder,
  updateAndReturn,
  updateLiveAndReturn,
} from "./crud";
// Dependency-edge replacement + read (project/task blockedByIds)
export { dependencyIdsFor, replaceDependencyEdges } from "./dependency-edges";
export type { ListReadIntent } from "./query";
// Query helpers
export {
  arrayOverlapOrPresence,
  assertNoDependents,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  correlated,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  eqAnyRequested,
  executeListQueryWithCount,
  formatSearchTerm,
  idSetPresence,
  isNotDeleted,
  lockAndValidateForDelete,
  matchesStringValues,
  notDeleted,
  presenceCondition,
  rangeConditions,
  textArrayMatches,
  uuidArrayParam,
} from "./query";
// Relation loaders
export { imageOrder, relations } from "./relations";
export type {
  MappableImageRecord,
  RowWithOptionalAliases,
  RowWithOptionalAliasesAndTags,
} from "./transform";
// Transform helpers
export {
  buildPartialUpdateValues,
  mapImages,
  mapRelation,
  parseInventoryAmount,
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "./transform";
