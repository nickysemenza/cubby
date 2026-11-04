import { sql, type AnyColumn, type SQL } from "drizzle-orm";

const TEXT_HASH_REF = ["md5((", ")::text)::uuid"] as const;

/**
 * A non-UUID derived input captures its stored text through this expression.
 * DDL and runtime selectors share it without importing application services.
 * NULL stays NULL; a collision only enrolls an additional canonical computation.
 */
export const textHashRefSqlText = (expression: string): string =>
  `${TEXT_HASH_REF[0]}${expression}${TEXT_HASH_REF[1]}`;

export const textHashRefSql = (expression: AnyColumn | SQL): SQL =>
  sql`${sql.raw(TEXT_HASH_REF[0])}${expression}${sql.raw(TEXT_HASH_REF[1])}`;
