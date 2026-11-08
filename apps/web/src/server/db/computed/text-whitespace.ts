import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { TEXT_WHITESPACE } from "~/lib/text-whitespace";

/** The same whitespace set as in-memory text checks, independent of PG locale. */
export const trimTextSql = (value: SQLWrapper) =>
  sql`btrim(${value}, ${TEXT_WHITESPACE})`;
export const hasTextSql = (value: SQLWrapper) =>
  sql`coalesce(${trimTextSql(value)} <> '', false)`;

/** Group keys, array filters and tag rosters share trimmed, nonempty values. */
export const nonEmptyTextValuesSql = (value: SQLWrapper): SQL<string[]> =>
  sql`ARRAY(SELECT ${trimTextSql(sql`__list_text_value`)} FROM unnest(${value}) AS __list_text_value WHERE ${hasTextSql(sql`__list_text_value`)})`;
