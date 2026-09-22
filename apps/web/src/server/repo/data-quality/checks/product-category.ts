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
      // Only a root category carries a feature; a group/type inherits its
      // root's feature (see `categoryFeatureSql`, product-category-sql.ts).
      expected: (t: ProductCategory) => sql`${t.parentId} IS NULL`,
      missing: (t: ProductCategory) => sql`${t.feature} IS NULL`,
    },
  },
});
