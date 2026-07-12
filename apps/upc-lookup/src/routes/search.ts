import { Hono } from "hono";
import { like, or, sql } from "drizzle-orm";
import { clamp } from "es-toolkit";
import type { Env } from "../types";
import { createDb, schema } from "../db";
import { getImageUrl } from "../storage/images";
import { productSourceSchema, type SearchResponse } from "../schemas/product";

const search = new Hono<{ Bindings: Env }>();

search.get("/", async (c) => {
  const query = c.req.query("q");
  const baseUrl = new URL(c.req.url).origin;
  const limitStr = c.req.query("limit");
  const limit = clamp(parseInt(limitStr || "20", 10), 1, 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);

  if (!query || query.trim().length === 0) {
    return c.json(
      { error: "Query parameter 'q' is required", code: "MISSING_QUERY" },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const searchPattern = `%${query}%`;
  const where = or(
    like(schema.products.name, searchPattern),
    like(schema.products.manufacturer, searchPattern),
    like(schema.products.brand, searchPattern),
  );

  // Page of matches and total count are independent — one round trip.
  const [products, countResult] = await Promise.all([
    db.query.products.findMany({ where, limit, offset }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.products)
      .where(where),
  ]);

  const total = countResult[0]?.count ?? 0;

  const response: SearchResponse = {
    products: products.map((p) => ({
      upc: p.upc,
      name: p.name,
      manufacturer: p.manufacturer,
      brand: p.brand,
      category: p.category,
      description: p.description,
      priceDollars: p.priceDollars,
      imageUrl: p.imageKey ? getImageUrl(p.imageKey, baseUrl) : null,
      source: productSourceSchema.parse(p.source),
    })),
    total,
  };

  return c.json(response);
});

export { search };
