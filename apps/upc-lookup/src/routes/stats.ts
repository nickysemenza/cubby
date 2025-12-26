import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { createDb, schema } from "../db";
import type { StatsResponse } from "../schemas/product";

const stats = new Hono<{ Bindings: Env }>();

/** Get stats data - exported for use by admin UI */
export async function getStats(
  db: ReturnType<typeof createDb>,
): Promise<StatsResponse> {
  // Get total product count
  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.products);
  const totalProducts = totalResult[0]?.count ?? 0;

  // Get counts by source
  const upcitemdbResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.products)
    .where(eq(schema.products.source, "upcitemdb"));
  const upcitemdbCount = upcitemdbResult[0]?.count ?? 0;

  // Get count of products with images (R2 objects)
  const imagesResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.products)
    .where(sql`${schema.products.imageKey} IS NOT NULL`);
  const r2Objects = imagesResult[0]?.count ?? 0;

  return {
    totalProducts,
    bySource: {
      upcitemdb: upcitemdbCount,
    },
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
