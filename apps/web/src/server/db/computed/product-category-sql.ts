import { entitySchema } from "@cubby/schemas/entity";
import { fieldResolutionEvaluationSchema } from "@cubby/schemas/field-resolution";
import {
  PRODUCT_CATEGORY_MAX_DEPTH,
  type ProductCategoryFeature,
  productCategoryFeatureValues,
  type ProductCategorySummary,
} from "@cubby/schemas/product-category-fields";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/** Constants below are inlined with `sql.raw` (not `.inlineParams()`): under the
 * relational `extras` API (`db.query.product.findFirst({ extras: {...} })`),
 * drizzle's `mapColumnsInSQLToAlias` (alias.js) rebuilds nested SQL via
 * `sql.join(...)`, which silently drops `.inlineParams()`'s inline flag and binds
 * the value as a parameter instead — breaking the requirement below that repeated
 * SELECT/GROUP BY expressions stay textually identical. Both values are
 * compile-time literals: the depth is a module constant, and the feature is
 * validated against the feature enum by `featureLiteral` before it ever reaches
 * `sql.raw`, so no user input can reach a raw template. */
const MAX_ANCESTOR_DEPTH = sql.raw(String(PRODUCT_CATEGORY_MAX_DEPTH - 1));

/** Quotes a feature as a raw SQL literal after validating it is a real member of
 * the feature enum — the only guard standing between `sql.raw` and injection. */
function featureLiteral(feature: ProductCategoryFeature): SQL {
  if (!productCategoryFeatureValues.includes(feature)) {
    throw new Error(`Invalid product category feature: ${String(feature)}`);
  }
  return sql.raw(`'${feature}'`);
}

/** Resolve matching categories once; overrides stop propagation to descendants. */
export const categoryFeatureInSql = (
  categoryIdExpr: SQL,
  features: readonly ProductCategoryFeature[],
) => {
  if (features.length === 0) return sql<boolean>`false`;
  const literals = sql.join(features.map(featureLiteral), sql`, `);
  return sql<boolean>`COALESCE(${categoryIdExpr} IN (
    WITH RECURSIVE feature_categories AS (
      SELECT c."id", 0 AS depth, ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."feature" IN (${literals}) AND c."deletedAt" IS NULL
      UNION ALL
      SELECT child."id", a.depth + 1, a.visited || child."id"
      FROM feature_categories a
      JOIN "ProductCategory" child ON child."parentId" = a."id"
      WHERE child."deletedAt" IS NULL AND child."feature" IS NULL
        AND a.depth < ${MAX_ANCESTOR_DEPTH}
        AND NOT child."id" = ANY(a.visited)
    ) SELECT "id" FROM feature_categories
  ), false)`;
};

/** True only when the closest non-null ancestor feature matches. */
export const categoryFeatureSql = (
  categoryIdExpr: SQL,
  feature: ProductCategoryFeature,
) => categoryFeatureInSql(categoryIdExpr, [feature]);

/** A nullable JSON summary expression for product and relation projections. */
export const categorySummarySql = (categoryIdExpr: SQL) =>
  sql<ProductCategorySummary | null>`(
    WITH RECURSIVE ancestors AS (
      SELECT c."id", c."parentId", c."shortcode", c."name", c."feature", 0 AS depth,
             ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."id" = ${categoryIdExpr} AND c."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentId", parent."shortcode", parent."name", parent."feature", a.depth + 1,
             a.visited || parent."id"
      FROM ancestors a
      JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL AND a.depth < ${MAX_ANCESTOR_DEPTH}
        AND NOT parent."id" = ANY(a.visited)
    )
    SELECT json_build_object(
      'id', (SELECT "shortcode" FROM ancestors ORDER BY depth LIMIT 1),
      ${"name"}::text, (SELECT "name" FROM ancestors ORDER BY depth LIMIT 1),
      'path', json_agg(json_build_object('id', "shortcode", ${"name"}::text, "name") ORDER BY depth DESC),
      'feature', (SELECT "feature" FROM ancestors WHERE "feature" IS NOT NULL ORDER BY depth LIMIT 1)
    ) FROM ancestors
    HAVING count(*) > 0
  )`;

/** The category that supplies an effective stock-tracking decision. */
const categoryStockTrackingSchema = z.object({
  value: z.boolean().nullable(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  evaluation: z.array(fieldResolutionEvaluationSchema).optional(),
});
export type CategoryStockTracking = z.infer<typeof categoryStockTrackingSchema>;

/** Categories whose nearest live decision (their own or an ancestor's within
 * the supported depth) equals `value`. Uncorrelated, so a filter over every
 * Product resolves the taxonomy once, like `categoryFeatureInSql`. */
const stockTrackingCategoriesSql = (value: boolean) => sql`(
    WITH RECURSIVE decided AS (
      SELECT c."id", 0 AS depth, ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."stockTracked" = ${sql.raw(value ? "true" : "false")} AND c."deletedAt" IS NULL
      UNION ALL
      SELECT child."id", a.depth + 1, a.visited || child."id"
      FROM decided a
      JOIN "ProductCategory" child ON child."parentId" = a."id"
      WHERE child."deletedAt" IS NULL AND child."stockTracked" IS NULL
        AND a.depth < ${MAX_ANCESTOR_DEPTH}
        AND NOT child."id" = ANY(a.visited)
    ) SELECT "id" FROM decided
  )`;

/** A category's effective stock tracking: null when nothing decides it. */
export const categoryStockTrackedSql = (categoryIdExpr: SQL) =>
  sql<boolean | null>`(CASE
    WHEN ${categoryIdExpr} IN ${stockTrackingCategoriesSql(true)} THEN true
    WHEN ${categoryIdExpr} IN ${stockTrackingCategoriesSql(false)} THEN false
  END)`;

/** ADR 0013: a Product's own decision wins over its category's. */
export const productStockTrackedSql = (
  stockTrackedExpr: SQL,
  categoryIdExpr: SQL,
) =>
  sql<
    boolean | null
  >`COALESCE(${stockTrackedExpr}, ${categoryStockTrackedSql(categoryIdExpr)})`;

/** The nearest live decision at or above a category, with the category that
 * made it, for page-bounded reads that explain the value. Agrees with
 * `categoryStockTrackedSql` (asserted in the feature-query integration test). */
export const categoryStockTrackingSql = (categoryIdExpr: SQL) =>
  sql<CategoryStockTracking | null>`(
    WITH RECURSIVE ancestors AS (
      SELECT c."id", c."parentId", c."shortcode", c."name", c."stockTracked", 0 AS depth,
             ARRAY[c."id"] AS visited
      FROM "ProductCategory" c
      WHERE c."id" = ${categoryIdExpr} AND c."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentId", parent."shortcode", parent."name", parent."stockTracked", a.depth + 1,
             a.visited || parent."id"
      FROM ancestors a
      JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL AND a.depth < ${MAX_ANCESTOR_DEPTH}
        AND NOT parent."id" = ANY(a.visited)
    )
    SELECT jsonb_build_object(
      'value', (SELECT "stockTracked" FROM ancestors WHERE "stockTracked" IS NOT NULL ORDER BY depth LIMIT 1),
      'id', (SELECT "shortcode" FROM ancestors WHERE "stockTracked" IS NOT NULL ORDER BY depth LIMIT 1),
      ${"name"}::text, (SELECT "name" FROM ancestors WHERE "stockTracked" IS NOT NULL ORDER BY depth LIMIT 1),
      ${"evaluation"}::text, (SELECT jsonb_agg(jsonb_build_object('entityKind', ${entitySchema.enum.productCategory}::text, 'entityId', "shortcode", ${"name"}::text, "name", 'value', "stockTracked", ${"assigned"}::text, "stockTracked" IS NOT NULL) ORDER BY depth) FROM ancestors)
    ) WHERE EXISTS (SELECT 1 FROM ancestors)
  )`;
