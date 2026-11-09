/**
 * Database helpers module.
 *
 * Re-exports all database helper functions.
 * Worker static-entry modules use core/query directly to avoid loading CRUD
 * and relation metadata before a consuming handler.
 * check-server-closure.ts enforces that entry's size budget.
 */

export {
  databaseForTransaction,
  getDb,
  isTransaction,
  parentTransactionDatabase,
  runAfterCommit,
  runBeforeCommitDatabase,
  unwrapDb,
  withTransaction,
  withTransactionDatabase,
  withSnapshotWrite,
  withSnapshotWriteDatabase,
  withTransactionOn,
} from "./core";
export {
  applyImageOrder,
  associatePendingImages,
  batchUpdateWithCaseWhen,
  galleryBinding,
  insertAndReturn,
  nextImageSortOrder,
  updateAndReturn,
  touchUpdatedAt,
  updateLiveAndReturn,
} from "~/server/db/helpers/crud";
export type { ImageJoinBinding } from "~/server/db/helpers/crud";
export type { ImageJoinTable } from "~/server/db/helpers/crud";
export type { ListReadIntent } from "~/server/db/helpers/query";
export {
  arrayOverlapOrPresence,
  assertNoDependents,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  sqlEnumConstant,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  flagCondition,
  formatSearchTerm,
  householdDayRangeConditions,
  householdDaySql,
  householdDaySqlText,
  isNotDeleted,
  lockAndValidateForDelete,
  matchesStringValues,
  shortcodeSetCondition,
  presenceCondition,
  rangeConditions,
  textArrayMatches,
  uuidArrayParam,
} from "~/server/db/helpers/query";
export { relations } from "./relations";
export type { MappableImageRecord } from "~/server/db/helpers/transform";
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
