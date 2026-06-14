import {
  sqliteTable,
  text,
  real,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const products = sqliteTable(
  "products",
  {
    upc: text("upc").primaryKey(),
    name: text("name").notNull(),
    manufacturer: text("manufacturer"),
    brand: text("brand"),
    category: text("category"),
    description: text("description"),
    priceDollars: real("price_dollars"), // USD
    imageKey: text("image_key"),
    source: text("source").notNull(), // "upcitemdb"
    sourceData: text("source_data"), // Full JSON response from external API
    createdAt: text("created_at").default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_products_name").on(table.name),
    index("idx_products_manufacturer").on(table.manufacturer),
    index("idx_products_brand").on(table.brand),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

// A UPC that was looked up but no source had data — a "miss". Cached so the
// same dead UPC isn't re-queried against the external API on every scan
// (the external tier is ~100 req/day). Surfaced as a worklist in the admin UI;
// fixing one (creating a product for the UPC) deletes its miss row.
export const upcMisses = sqliteTable("upc_misses", {
  upc: text("upc").primaryKey(),
  attempts: integer("attempts").notNull().default(1),
  lastCheckedAt: text("last_checked_at").default(sql`(datetime('now'))`),
});

export type UpcMiss = typeof upcMisses.$inferSelect;
export type NewUpcMiss = typeof upcMisses.$inferInsert;
