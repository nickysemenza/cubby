import type { StatsResponse } from "@cubby/upc-contract";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { createDb, schema } from "../db";

const stats = new Hono<{ Bindings: Env }>();

/** Get stats data - exported for use by admin UI */
export async function getStats(
  db: ReturnType<typeof createDb>,
): Promise<StatsResponse> {
  // The two aggregates are independent — run them in one round trip. Total
  // products is the sum of the per-source counts (every row has a source), so
  // it's derived rather than a third query.
  const [sourceRows, imagesResult] = await Promise.all([
    db
      .select({
        source: schema.products.source,
        count: sql<number>`count(*)`,
      })
      .from(schema.products)
      .groupBy(schema.products.source),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.products)
      .where(sql`${schema.products.imageKey} IS NOT NULL`),
  ]);

  const bySource: Record<string, number> = {};
  for (const row of sourceRows) {
    bySource[row.source] = row.count;
  }
  const totalProducts = Object.values(bySource).reduce((a, b) => a + b, 0);
  const r2Objects = imagesResult[0]?.count ?? 0;

  return {
    totalProducts,
    bySource,
    storageUsed: {
      d1Rows: totalProducts,
      r2Objects,
    },
  };
}

stats.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const response = await getStats(db);
  return c.json(response);
});

export { stats };
