import { type AnyColumn, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** `term` as a LIKE pattern that matches it literally, for case-insensitive equality. */
export const escapeLike = (term: string): string =>
  term.replace(/[\\%_]/g, "\\$&");

/**
 * The ILIKE pattern for "contains `term` literally": backslash, `%`, and `_` in the
 * term are escaped so a search for `50%` or `a_b` cannot widen into a
 * wildcard match. Every hand-written substring ILIKE goes through this.
 */
export const ilikeContains = (term: string): string => `%${escapeLike(term)}%`;

/** Expiring read-only entities have no soft-delete column; every retained row is live. */
export const notDeleted = (table: PgTable | { deletedAt: AnyColumn }) =>
  "deletedAt" in table && table.deletedAt ? isNull(table.deletedAt) : sql`true`;

/**
 * Raw-text actual/planned Expense predicates for an aliased `"Expense"` in
 * correlated subqueries and string-built SQL. Schema-free so repository-owned
 * modules can use them (the column forms live in `computed/expense-aggregate-sql`).
 */
export const actualExpenseSql = (alias: string): string =>
  `${alias}."future" = false`;
export const plannedExpenseSql = (alias: string): string =>
  `${alias}."future" = true`;
