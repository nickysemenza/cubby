import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
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
