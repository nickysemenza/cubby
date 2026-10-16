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
} from "~/server/db/helpers/crud";
export type { ImageJoinBinding } from "~/server/db/helpers/crud";
export type { ImageJoinTable } from "~/server/db/helpers/crud";
export type { ListReadIntent } from "~/server/db/helpers/query";
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
  anyOfCondition,
  flagCondition,
  formatSearchTerm,
  householdDayRangeConditions,
  householdDaySql,
  householdDaySqlText,
  idSetPresence,
  isNotDeleted,
  lockAndValidateForDelete,
  matchesStringValues,
  shortcodeSetCondition,
  presenceCondition,
  rangeConditions,
  textArrayMatches,
  uuidArrayParam,
} from "~/server/db/helpers/query";
// Relation loaders
export { imageOrder, relations, singularAttachment } from "./relations";
export type { MappableImageRecord } from "~/server/db/helpers/transform";
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
} from "~/server/db/helpers/transform";

export {
  escapeLike,
  ilikeContains,
  notDeleted,
} from "~/server/db/helpers/predicates";
