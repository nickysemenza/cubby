import { sql, type SQL } from "drizzle-orm";

/** Discovery and invalidation use the same rounded absolute money pool. */
export const transferPoolAmountSql = (amount: SQL): SQL =>
  sql`round(abs(${amount}) * 100)::bigint`;
