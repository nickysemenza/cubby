/**
 * Database query helper functions.
 * Search formatting, ordering, and list queries with counts.
 */

import type { SortParams } from "@cubby/schemas/pagination";
import type { AnyColumn, SQL } from "drizzle-orm";
import { and, asc, ilike, inArray, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createAppError } from "~/server/api/trpc";
import type { DrizzleTransaction } from "~/server/db";
import { TraceNames, withTrace } from "~/server/tracing";

import { unwrapDb } from "./core";

/**
 * Build a combined WHERE clause from notDeleted + search terms + extra conditions.
 * Reduces the repetitive filter-building pattern across repos.
 */
export function buildSearchConditions(
  table: { deletedAt: AnyColumn },
  searchFilters: Array<{ column: AnyColumn; term: string | undefined }>,
  extraConditions?: Array<SQL | undefined>,
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [notDeleted(table)];

  for (const { column, term } of searchFilters) {
    conditions.push(formatSearchTerm(column, term));
  }

  if (extraConditions) {
    conditions.push(...extraConditions);
  }

  const defined = conditions.filter((c): c is SQL => c !== undefined);
  return defined.length > 0 ? and(...defined) : undefined;
}

/**
 * Helper function to format search terms for PostgreSQL pattern matching.
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
 */
export const notDeleted = <T extends { deletedAt: AnyColumn }>(table: T) =>
  isNull(table.deletedAt);

/**
 * Filter out soft-deleted items from an array.
 * Use this in transformation functions when Drizzle relations can't apply WHERE filters.
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
 * When `groupBy` is provided and is in `allowedFields`, prepends a primary
 * sort on that column (ASC NULLS LAST) so group members are contiguous.
 * The user's chosen sort becomes the secondary sort within each group.
 */
export const buildOrderBy = <T extends PgTable>(
  table: T,
  sort: SortParams,
  allowedFields: string[],
  groupBy?: string,
): SQL[] => {
  const clauses: SQL[] = [];

  // Prepend group-by column as primary sort (if provided and valid)
  if (groupBy && allowedFields.includes(groupBy) && groupBy !== sort.orderBy) {
    const groupColumn = table[groupBy as keyof T] as AnyColumn | undefined;
    if (groupColumn) {
      clauses.push(sql`${groupColumn} asc nulls last`);
    }
  }

  if (!allowedFields.includes(sort.orderBy)) {
    return clauses;
  }
  const column = table[sort.orderBy as keyof T] as AnyColumn | undefined;
  if (!column) return clauses;
  // ASC: nulls at end by default in Postgres
  // DESC: use NULLS LAST to put nulls at the bottom instead of the top
  if (sort.direction === "asc") {
    clauses.push(asc(column));
  } else {
    clauses.push(sql`${column} desc nulls last`);
  }
  return clauses;
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
 */
export async function lockAndValidateForDelete<TId extends string>(
  tx: DrizzleTransaction,
  table: PgTable & { id: AnyColumn; deletedAt: AnyColumn },
  ids: TId[],
  entityName: string,
): Promise<void> {
  const locked = await unwrapDb(tx)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for select()
    .select({ id: table.id as any })
    .from(table)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
    .where(and(inArray(table.id as any, ids), notDeleted(table)))
    .for("update"); // 🔒 Acquires row-level lock

  if (locked.length !== ids.length) {
    const foundIds = locked.map((e) => e.id as TId);
    const missingIds = ids.filter((id) => !foundIds.includes(id));
    throw createAppError(
      `${entityName.toUpperCase()}_NOT_FOUND` as "PRODUCT_NOT_FOUND",
      `${entityName}s not found or already deleted: ${missingIds.join(", ")}`,
    );
  }
}
