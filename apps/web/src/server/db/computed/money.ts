import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Preserve the requested PostgreSQL result type at the dollar read boundary. */
export function minorToDollarsSql(
  value: SQLWrapper,
  type: "numeric",
): SQL<string>;
export function minorToDollarsSql(
  value: SQLWrapper,
  type: "float8",
): SQL<number>;
export function minorToDollarsSql(
  value: SQLWrapper,
  type: "numeric" | "float8",
): SQL {
  return sql`${value}::${sql.raw(type)} / 100`;
}

export function dollarsToMinorSql(value: SQLWrapper): SQL<bigint> {
  return sql<bigint>`round(${value}::numeric * 100)::bigint`;
}
