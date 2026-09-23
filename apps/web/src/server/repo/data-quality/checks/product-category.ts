import { sql } from "drizzle-orm";

import { productCategory } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type ProductCategory = typeof productCategory;

export const productCategoryChecks = defineEntityChecks({
  entity: "productCategory",
  table: productCategory,
  checks: {
    category_description: {
      missing: (t: ProductCategory) =>
        sql`(${t.description} IS NULL OR trim(${t.description}) = '')`,
    },
    category_feature: {
      // Every root needs a binding; a descendant inherits the closest one
      // (see `categoryFeatureSql`, product-category-sql.ts) and may carry
      // its own, so a missing feature is only a gap on a root.
      expected: (t: ProductCategory) => sql`${t.parentId} IS NULL`,
      missing: (t: ProductCategory) => sql`${t.feature} IS NULL`,
    },
  },
});
