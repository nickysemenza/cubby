import {
  wishPriceRangeOut,
  type WishPriceRange,
} from "@cubby/schemas/wish-fields";
import { sql, type SQL } from "drizzle-orm";

/** Null prices never count as free candidates; an entirely unpriced wish has no range. */
export const wishPriceRangeSql = (
  price: SQL,
  partition?: SQL,
): SQL<WishPriceRange | null> => {
  const keys = wishPriceRangeOut.keyof().enum;
  const aggregate = (fn: "min" | "max" | "count") =>
    sql`${sql.raw(fn)}(${price})${partition ? sql` OVER (PARTITION BY ${partition})` : sql``}`;
  return sql`CASE WHEN ${aggregate("count")} = 0 THEN NULL ELSE jsonb_build_object(
    ${keys.low}::text, ${aggregate("min")}, ${keys.high}::text, ${aggregate("max")}, ${keys.pricedCount}::text, ${aggregate("count")}
  ) END`;
};
