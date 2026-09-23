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
  imageCascadeChild,
  imageJoinBindings,
  insertAndReturn,
  nextImageSortOrder,
  syncEntityImages,
  updateAndReturn,
  updateLiveAndReturn,
} from "./crud";
export type { ImageJoinBinding } from "./crud";
export type { ImageJoinTable } from "./crud";
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
  shortcodeSetCondition,
  notDeleted,
  presenceCondition,
  rangeConditions,
  textArrayMatches,
  uuidArrayParam,
} from "./query";
// Relation loaders
export {
  imageOrder,
  relations,
  singularAttachment,
  singularAttachmentImage,
} from "./relations";
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
