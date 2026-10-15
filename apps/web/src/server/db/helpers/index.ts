/**
 * Database helpers module.
 *
 * Re-exports all database helper functions.
 * Worker static-entry modules use core/query directly to avoid loading CRUD
 * and relation metadata before a consuming handler.
 * check-server-closure.ts enforces that entry's size budget.
 */

// Core database access
export {
  databaseForTransaction,
  getDb,
  isTransaction,
  parentTransactionDatabase,
  runAfterCommit,
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
  touchUpdatedAt,
  updateLiveAndReturn,
} from "./crud";
export type { ImageJoinBinding } from "./crud";
export type { ImageJoinTable } from "./crud";
export type { ListReadIntent } from "./query";
// Query helpers
export {
  arrayOverlapOrPresence,
  assertNoDependents,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  correlated,
  sqlEnumConstant,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  eqAnyRequested,
  executeListQueryWithCount,
  escapeLike,
  formatSearchTerm,
  ilikeContains,
  householdDayRangeConditions,
  householdDaySql,
  householdDaySqlText,
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
export { imageOrder, relations, singularAttachment } from "./relations";
export type { MappableImageRecord } from "./transform";
// Transform helpers
export {
  amountFromColumns,
  amountJsonSql,
  amountToColumns,
  buildPartialUpdateValues,
  mapImages,
  mapRelation,
  optionalAmountToColumns,
  parseInventoryAmount,
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
  brandJoinShortcode,
} from "./transform";
