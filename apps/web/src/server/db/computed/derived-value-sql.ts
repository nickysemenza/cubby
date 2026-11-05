import { type AnyColumn, type SQL, sql, getTableName } from "drizzle-orm";

import { entityStoredDerivedDeclarations } from "~/server/db/derived-declarations";
import { storedSourceSql } from "~/server/db/derived-source-sql";

/** Nested relational extras resolve the same declared source as top-level reads. */
const source = (id: AnyColumn, key: string): SQL => {
  const declaration = entityStoredDerivedDeclarations().find(
    (entry) => entry.table === getTableName(id.table) && entry.key === key,
  );
  if (!declaration)
    throw new Error(
      `Undeclared nested result: ${getTableName(id.table)}.${key}`,
    );
  return storedSourceSql(declaration, sql`${id}`);
};
export const storedSortNumberSql = (id: AnyColumn, key: string) =>
  sql<number | null>`(SELECT "sortNumber" FROM (${source(id, key)}) projected)`;

/** JSON null is a successful empty result; only a missing row uses the fallback. */
export const storedValueOrSql = (id: AnyColumn, key: string, fallback: SQL) =>
  sql<unknown>`COALESCE((SELECT value FROM (${source(id, key)}) projected), to_jsonb(${fallback}))`;
