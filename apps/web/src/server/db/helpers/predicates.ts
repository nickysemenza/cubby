import { type AnyColumn, isNull } from "drizzle-orm";

/** `term` as a LIKE pattern that matches it literally, for case-insensitive equality. */
export const escapeLike = (term: string): string =>
  term.replace(/[\\%_]/g, "\\$&");

/**
 * The ILIKE pattern for "contains `term` literally": backslash, `%`, and `_` in the
 * term are escaped so a search for `50%` or `a_b` cannot widen into a
 * wildcard match. Every hand-written substring ILIKE goes through this.
 */
export const ilikeContains = (term: string): string => `%${escapeLike(term)}%`;

export const notDeleted = <T extends { deletedAt: AnyColumn }>(table: T) =>
  isNull(table.deletedAt);
