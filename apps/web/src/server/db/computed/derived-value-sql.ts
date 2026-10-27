import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * Relational-query extras over stored derived values (ADR 0021), for nested
 * rows a page loads in its one relational read. A typed id column survives
 * the relational layer's alias rewriting. Top-level list reads use
 * `storedDerivedSql`, which also validates the declaration.
 */
export const storedSortNumberSql = (id: AnyColumn, key: string) =>
  sql<
    number | null
  >`(SELECT "sortNumber" FROM "DerivedValue" WHERE "entityId" = ${id} AND key = ${key})`;

/**
 * A stored value's JSON, or `fallback` until its first publication: a stored
 * JSON null stays null, while a missing row reads the fallback.
 */
export const storedValueOrSql = (id: AnyColumn, key: string, fallback: SQL) =>
  sql<unknown>`COALESCE((SELECT value FROM "DerivedValue" WHERE "entityId" = ${id} AND key = ${key}), to_jsonb(${fallback}))`;
