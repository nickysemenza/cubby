import {
  getTableColumns,
  sql,
  type GetColumnData,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** Retained contract decoders apply to the same named columns of a Decision projection. */
export function decisionProjectionColumns<T extends PgTable>(table: T) {
  // SAFETY: metadata supplies every key and its own decoder without changing the value type.
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      sql`${column}`.mapWith(column).as(column.name),
    ]),
  ) as {
    [K in keyof T["_"]["columns"]]: SQL.Aliased<
      GetColumnData<T["_"]["columns"][K]>
    >;
  };
}
