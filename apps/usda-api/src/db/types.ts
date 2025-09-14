import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// FTS5 Virtual Table types - for type safety only, not managed by Drizzle migrations
export const foodSearch = sqliteTable('food_search', {
  fdc_id: integer('fdc_id'),
  data_type: text('data_type'),
  description: text('description'),
  short_description: text('short_description'),
  brand_name: text('brand_name'),
  brand_owner: text('brand_owner'),
});

export type FoodSearchTable = typeof foodSearch;
export type FoodSearch = typeof foodSearch.$inferSelect;
