import { count, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";

/**
 * Bare `SELECT 1` round-trip — dev-only latency probe, no rows returned.
 */
export const pingDb = async (db: Database): Promise<void> => {
  await getDb(db).execute(sql`SELECT 1`);
};

/**
 * Scalar product count — dev-only latency probe for a trivial indexed query.
 */
export const countProducts = async (db: Database): Promise<number> => {
  const rows = await getDb(db).select({ n: count() }).from(product);
  return rows[0]?.n ?? 0;
};
