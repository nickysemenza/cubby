import {
  type ProductCategoryFeature,
  productCategoryFeatureValues,
} from "@cubby/schemas/product-category-fields";
import { type SQL, sql } from "drizzle-orm";

import { effectiveFieldInSql } from "~/server/db/computed/effective-field";

// The feature is inlined with `sql.raw`, never bound: under drizzle's
// relational `extras` a bound value breaks the textual identity a SELECT and
// its GROUP BY need (see product-category-sql.unit.test.ts).

/** Quotes a feature as a raw SQL literal after validating it is a real member of
 * the feature enum — the only guard standing between `sql.raw` and injection. */
function featureLiteral(feature: ProductCategoryFeature): SQL {
  if (!productCategoryFeatureValues.includes(feature)) {
    throw new Error(`Invalid product category feature: ${String(feature)}`);
  }
  return sql.raw(`'${feature}'`);
}

/** True when a category's effective feature (`resolution.inherit`) is one
 * of `features`; false for no category or no feature. The taxonomy resolves
 * once per query (the set form), not per row. */
export const categoryFeatureInSql = (
  categoryIdExpr: SQL,
  features: readonly ProductCategoryFeature[],
) => {
  if (features.length === 0) return sql<boolean>`false`;
  const matches = effectiveFieldInSql(
    "productCategory",
    "feature",
    categoryIdExpr,
    sql.join(features.map(featureLiteral), sql`, `),
  );
  if (matches === null)
    throw new Error("productCategory.feature no longer inherits by hierarchy");
  return matches;
};

/** True only when the category's effective feature matches. */
export const categoryFeatureSql = (
  categoryIdExpr: SQL,
  feature: ProductCategoryFeature,
) => categoryFeatureInSql(categoryIdExpr, [feature]);
