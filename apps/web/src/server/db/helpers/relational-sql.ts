import {
  Column,
  type AnyColumn,
  SQL,
  getOriginalColumnFromAlias,
  getTableColumns,
  type SQLChunk,
  type SQLWrapper,
  EmptyFilter,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { OuterColumnSql, outer } from "~/server/db/helpers/related";

/** Bind prebuilt expressions to RQB's row alias without changing subquery aliases. */
export function relationalSql<T>(
  table: PgTable,
  expression: SQLWrapper<T>,
): SQL<T>;
export function relationalSql<T>(
  table: PgTable,
  expression: SQLWrapper<T> | undefined,
): SQL<T> | typeof EmptyFilter;
export function relationalSql<T>(
  table: PgTable,
  expression: SQLWrapper<T> | undefined,
): SQL<T> | typeof EmptyFilter {
  if (expression === undefined) return EmptyFilter;
  const columns = new Map<AnyColumn, AnyColumn>(
    Object.values(getTableColumns(table)).map((column) => [
      getOriginalColumnFromAlias(column),
      column,
    ]),
  );
  const bindChunk = (chunk: SQLChunk): SQLChunk => {
    if (chunk instanceof OuterColumnSql) {
      const column = columns.get(chunk.column);
      return column ? outer(column) : chunk;
    }
    if (chunk instanceof Column) return columns.get(chunk) ?? chunk;
    if (chunk instanceof SQL) return bind(chunk);
    if (chunk instanceof SQL.Aliased)
      return bind(chunk.sql).as(chunk.fieldAlias);
    if (Array.isArray(chunk)) return chunk.map(bindChunk);
    return chunk;
  };
  const bind = (query: SQL): SQL => {
    if (query instanceof OuterColumnSql) {
      const column = columns.get(query.column);
      return column ? outer(column) : query;
    }
    const chunks = query.queryChunks.map(bindChunk);
    // Decoder and parameter flags belong to the expression, not its alias.
    return Object.assign(new SQL(chunks), query, { queryChunks: chunks });
  };
  return Object.assign(new SQL<T>([]), bind(expression.getSQL()));
}
