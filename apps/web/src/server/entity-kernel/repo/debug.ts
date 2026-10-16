import { count, sql } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { product } from "~/server/db/retained-tables";

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
