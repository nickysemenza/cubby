import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  type AnyPgColumn,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { generatedProductCategoryColumns } from "./generated/entity-columns.gen";

/** Kept separate so the self-reference can receive the table's real column. */
export const productCategory = pgTable(
  "ProductCategory",
  generatedProductCategoryColumns({
    productCategory: (): AnyPgColumn => productCategory.id,
  }),
  (table) => [
    uniqueIndex("ProductCategory_shortcode_unique").on(table.shortcode),
    uniqueIndex("ProductCategory_parent_name_key")
      .on(table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("ProductCategory_feature_live_unique")
      .on(table.feature)
      .where(sql`${table.deletedAt} IS NULL AND ${table.feature} IS NOT NULL`),
    index("ProductCategory_parentId_idx").on(table.parentId),
    index("ProductCategory_feature_idx").on(table.feature),
    check("ProductCategory_sortOrder_check", sql`${table.sortOrder} >= 0`),
    check(
      "ProductCategory_feature_check",
      sql`${table.feature} IS NULL OR ${table.feature} IN ('food', 'books', 'tools', 'tool-consumables', 'tool-accessories', 'storage', 'hardware', 'electronics', 'software', 'household', 'supplies', 'apparel')`,
    ),
  ],
);
