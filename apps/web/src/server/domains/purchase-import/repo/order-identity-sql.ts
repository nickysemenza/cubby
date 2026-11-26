import { NORMALIZED_ORDER_ID_SQL } from "@cubby/schemas/purchase-order-identity";
import { sql, type SQLWrapper } from "drizzle-orm";

/** `normalizeOrderKey` for a stored order id column. */
export const normalizedOrderIdSql = (column: SQLWrapper) =>
  sql<string>`${sql.raw(NORMALIZED_ORDER_ID_SQL[0])}${column}${sql.raw(NORMALIZED_ORDER_ID_SQL[1])}`;

/** Indexed hash narrows candidates; equality still compares their full keys. */
export const matchingOrderIdSql = (
  stored: SQLWrapper,
  candidate: SQLWrapper,
) => {
  const key = normalizedOrderIdSql(stored);
  const wanted = normalizedOrderIdSql(candidate);
  return sql<boolean>`${stored} IS NOT NULL AND md5(${key}) = md5(${wanted}) AND ${key} = ${wanted}`;
};
