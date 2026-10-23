import { sql, type SQLWrapper } from "drizzle-orm";

import { TEXT_WHITESPACE } from "~/lib/text-whitespace";

/** The same whitespace set as in-memory text checks, independent of PG locale. */
export const trimTextSql = (value: SQLWrapper) =>
  sql`btrim(${value}, ${TEXT_WHITESPACE})`;
export const hasTextSql = (value: SQLWrapper) =>
  sql`coalesce(${trimTextSql(value)} <> '', false)`;
