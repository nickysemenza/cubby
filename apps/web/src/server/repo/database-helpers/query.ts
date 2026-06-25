/**
 * Database query helper functions.
 * Search formatting, ordering, and list queries with counts.
 */

import type { SortParams } from "@cubby/schemas/pagination";
import type { AppErrorReason } from "@cubby/shared";
import type { AnyColumn, SQL } from "drizzle-orm";
import { and, asc, ilike, inArray, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
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
 * Row-level twin of {@link notDeleted}: a predicate over an already-fetched
 * record (not a SQL condition). Use this to filter soft-deleted rows in JS —
 * e.g. relations loaded in a `with` block, or join-table associations — where
 * the SQL `notDeleted()` can't apply. Keep the two in lockstep: `notDeleted`
 * filters at query time, `isNotDeleted` filters in memory.
 */
export const isNotDeleted = <T extends { deletedAt: Date | null }>(
  row: T,
): boolean => row.deletedAt === null;

/**
 * Count rows in a table matching an optional WHERE clause.
 * Wraps Drizzle's `db.$count`, which resolves directly to a number — replaces
 * the hand-rolled `select({ count: count() }).from(t).where(w)` + destructure.
 * For counts that need joins/group-by, query directly instead.
 */
export const countWhere = (
  db: Database | DrizzleTransaction,
  table: PgTable,
  where?: SQL,
): Promise<number> => unwrapDb(db).$count(table, where);

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
  countQuery: Promise<number>,
): Promise<{ data: T[]; count: number }> {
  return withTrace(TraceNames.db("listQueryWithCount"), async (span) => {
    const [data, count] = await Promise.all([dataQuery, countQuery]);
    span.setAttributes({
      "db.result_count": data.length,
      "db.total_count": count,
    });
    return { data, count };
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

/**
 * Guard a soft-delete against orphaning dependents. Given the dependent rows'
 * parent ids (the offending entities), dedupes them, refetches their names, and
 * throws a typed AppError naming them. No-op when there are no dependents. The
 * caller runs its own (entity-specific) dependent query and supplies the name
 * fetch — the shared part is the dedupe + refetch + count + join + throw.
 */
export async function assertNoDependents<TId extends string>(opts: {
  offendingParentIds: ReadonlyArray<TId | null | undefined>;
  fetchNames: (ids: TId[]) => Promise<ReadonlyArray<{ name: string }>>;
  reason: AppErrorReason;
  message: (count: number, names: string) => string;
}): Promise<void> {
  const ids = uniq(
    opts.offendingParentIds.filter((id): id is TId => id != null),
  );
  if (ids.length === 0) return;
  const offenders = await opts.fetchNames(ids);
  const names = offenders.map((o) => o.name).join(", ");
  throw createAppError(opts.reason, opts.message(offenders.length, names));
}
