/**
 * Database query helper functions.
 * Search formatting, ordering, and list queries with counts.
 */

import type { AnyColumn, SQL } from "drizzle-orm";
import { and, asc, ilike, inArray, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { createAppError } from "~/lib/error-utils";
import type { SortParams } from "~/schemas/pagination";
import type { DrizzleTransaction } from "~/server/db";
import { TraceNames, withTrace } from "~/server/tracing";

import { getDb } from "./core";

/**
 * Helper function to format search terms for PostgreSQL pattern matching.
 *
 * @param column - The column to search
 * @param term - The search term
 * @returns SQL condition for ILIKE search, or undefined if term is empty
 */
export const formatSearchTerm = (
  column: AnyColumn,
  term?: string,
): SQL | undefined => {
  if (term === undefined || term.trim() === "") {
    return undefined;
  }
  return ilike(column, `%${term}%`);
};

/**
 * Helper to filter out soft-deleted records.
 * Use this in where clauses to exclude records where deletedAt is set.
 *
 * @param table - Any table with a deletedAt column
 * @returns SQL condition for deletedAt IS NULL
 *
 * @example
 * ```typescript
 * // Single condition
 * where: notDeleted(product)
 *
 * // Combined with other conditions
 * where: and(eq(product.id, id), notDeleted(product))
 * ```
 */
export const notDeleted = <T extends { deletedAt: AnyColumn }>(table: T) =>
  isNull(table.deletedAt);

/**
 * Filter out soft-deleted items from an array.
 * Use this in transformation functions when Drizzle relations can't apply WHERE filters.
 *
 * @example
 * ```ts
 * const activeImages = filterDeleted(product.images);
 * const activeMappings = filterDeleted(product.unitMappings);
 * ```
 */
export function filterDeleted<T extends { deletedAt: Date | null }>(
  items: T[] | undefined | null,
): T[] {
  if (!items) return [];
  return items.filter((item) => item.deletedAt === null);
}

/**
 * Build order by clause from sort parameters.
 * Validates that the requested field is in the allowed list and returns
 * the appropriate asc/desc clause.
 *
 * @param table - The table schema
 * @param sort - Sort parameters (field and direction)
 * @param allowedFields - Array of field names that can be sorted on
 * @returns Array of order by clauses (empty if field not allowed)
 */
export const buildOrderBy = <T extends PgTable>(
  table: T,
  sort: SortParams,
  allowedFields: string[],
): SQL[] => {
  if (!allowedFields.includes(sort.orderBy)) {
    return [];
  }
  const column = table[sort.orderBy as keyof T] as AnyColumn | undefined;
  if (!column) return [];
  // ASC: nulls at end by default in Postgres
  // DESC: use NULLS LAST to put nulls at the bottom instead of the top
  if (sort.direction === "asc") {
    return [asc(column)];
  }
  return [sql`${column} desc nulls last`];
};

/**
 * Executes a data query and count query in parallel and wraps results in the standard
 * paginated list response format.
 *
 * This helper consolidates the common pattern of running two queries in parallel:
 * 1. The main data query (with pagination, filtering, sorting)
 * 2. The count query (total matching records without pagination)
 *
 * Note: If you need to transform results before returning, pass the transformation
 * as part of the data query promise chain, or manually destructure and transform.
 *
 * @param dataQuery - Promise that resolves to the array of data records
 * @param countQuery - Promise that resolves to array with count result
 * @returns Object with data array and total count
 *
 * @example
 * ```typescript
 * // Simple case - no transformation needed
 * return await executeListQueryWithCount(
 *   getDb(db).query.recipe.findMany({ where, orderBy, limit, offset }),
 *   getDb(db).select({ count: count() }).from(recipe).where(where)
 * );
 *
 * // With transformation - transform in the promise chain
 * const { data, count } = await executeListQueryWithCount(
 *   getDb(db).query.product.findMany({ where, orderBy, limit, offset })
 *     .then(results => Promise.all(results.map(r => transformToAPI(r)))),
 *   getDb(db).select({ count: count() }).from(product).where(where)
 * );
 * ```
 */
export async function executeListQueryWithCount<T>(
  dataQuery: Promise<T[]>,
  countQuery: Promise<{ count: number }[]>,
): Promise<{ data: T[]; count: number }> {
  return withTrace(TraceNames.db("listQueryWithCount"), async (span) => {
    const [data, [countResult]] = await Promise.all([dataQuery, countQuery]);
    span.setAttributes({
      "db.result_count": data.length,
      "db.total_count": countResult?.count ?? 0,
    });
    return { data, count: countResult?.count ?? 0 };
  });
}

/**
 * Locks entity records for update and validates they exist and aren't deleted.
 * Prevents race conditions by acquiring row-level locks before safety checks.
 *
 * Use this at the start of delete operations to ensure:
 * 1. Records are locked (prevents concurrent modifications)
 * 2. All requested IDs exist and aren't already deleted
 * 3. Other transactions wait until our transaction completes
 *
 * @param tx - Transaction to execute in
 * @param table - Table to lock records from
 * @param ids - Array of IDs to lock
 * @param entityName - Human-readable entity name for error messages (e.g., "Product")
 * @throws {AppError} If any IDs are not found or already deleted
 *
 * @example
 * ```typescript
 * await withTransaction(db, async (tx) => {
 *   // Lock products and validate they exist
 *   await lockAndValidateForDelete(tx, product, ids, "Product");
 *
 *   // Now safely check dependencies (other transactions will wait)
 *   const withInventory = await tx.query.inventoryEntry.findMany(...);
 *   if (withInventory.length > 0) throw error;
 *
 *   // Proceed with deletion
 * });
 * ```
 */
export async function lockAndValidateForDelete<TId extends string>(
  tx: DrizzleTransaction,
  table: PgTable & { id: AnyColumn; deletedAt: AnyColumn },
  ids: TId[],
  entityName: string,
): Promise<void> {
  const locked = await getDb(tx)
    .select({ id: table.id })
    .from(table)
    .where(and(inArray(table.id, ids), notDeleted(table)))
    .for("update"); // 🔒 Acquires row-level lock

  if (locked.length !== ids.length) {
    const foundIds = locked.map((e) => e.id as TId);
    const missingIds = ids.filter((id) => !foundIds.includes(id));
    throw createAppError(
      `${entityName.toUpperCase()}_NOT_FOUND`,
      `${entityName}s not found or already deleted: ${missingIds.join(", ")}`,
    );
  }
}
