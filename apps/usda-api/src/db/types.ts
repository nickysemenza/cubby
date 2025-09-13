import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

// FTS5 Virtual Table types - for type safety only, not managed by Drizzle migrations
export const foodSearch = sqliteTable("food_search", {
  fdcId: integer("fdc_id"),
  dataType: text("data_type"),
  description: text("description"),
  shortDescription: text("short_description"),
  brandName: text("brand_name"),
  brandOwner: text("brand_owner"),
});

export type FoodSearchTable = typeof foodSearch;
export type FoodSearch = typeof foodSearch.$inferSelect;
