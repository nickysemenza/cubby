/**
 * Database query helper functions.
 * Search formatting, ordering, and list queries with counts.
 */

import type { AnyColumn, SQL } from "drizzle-orm";
import { asc, ilike, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { SortParams } from "~/schemas/pagination";
import { TraceNames, withTrace } from "~/server/tracing";

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
