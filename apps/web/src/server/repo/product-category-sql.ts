import type { ProductCategoryId } from "@cubby/schemas/identifiers";
import {
  PRODUCT_CATEGORY_MAX_DEPTH,
  type ProductCategoryFeature,
  productCategoryFeatureValues,
  type ProductCategorySummary,
} from "@cubby/schemas/product-category-fields";
import { type SQL, sql } from "drizzle-orm";

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

/** True only when the closest non-null ancestor feature matches. */
export const categoryFeatureSql = (
  categoryIdExpr: SQL,
  feature: ProductCategoryFeature,
) => sql<boolean>`COALESCE((
  WITH RECURSIVE ancestors AS (
    SELECT c."id", c."parentId", c."feature", 0 AS depth, ARRAY[c."id"] AS visited
    FROM "ProductCategory" c WHERE c."id" = ${categoryIdExpr} AND c."deletedAt" IS NULL
    UNION ALL
    SELECT parent."id", parent."parentId", parent."feature", a.depth + 1, a.visited || parent."id"
    FROM ancestors a JOIN "ProductCategory" parent ON parent."id" = a."parentId"
    WHERE parent."deletedAt" IS NULL AND a.depth < ${MAX_ANCESTOR_DEPTH}
      AND NOT parent."id" = ANY(a.visited)
  ) SELECT "feature" = ${featureLiteral(feature)} FROM ancestors WHERE "feature" IS NOT NULL ORDER BY depth LIMIT 1
), false)`;

/** True only when the closest non-null ancestor feature is one of `features`. */
export const categoryFeatureInSql = (
  categoryIdExpr: SQL,
  features: readonly ProductCategoryFeature[],
) => {
  if (features.length === 0) return sql<boolean>`false`;
  const literals = sql.join(
    features.map((feature) => featureLiteral(feature)),
    sql`, `,
  );
  return sql<boolean>`COALESCE((
    WITH RECURSIVE ancestors AS (
      SELECT c."id", c."parentId", c."feature", 0 AS depth, ARRAY[c."id"] AS visited
      FROM "ProductCategory" c WHERE c."id" = ${categoryIdExpr} AND c."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentId", parent."feature", a.depth + 1, a.visited || parent."id"
      FROM ancestors a JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL AND a.depth < ${MAX_ANCESTOR_DEPTH}
        AND NOT parent."id" = ANY(a.visited)
    ) SELECT "feature" IN (${literals}) FROM ancestors WHERE "feature" IS NOT NULL ORDER BY depth LIMIT 1
  ), false)`;
};

/** Parenthesized id subquery containing the selected categories and descendants. */
export const categoryDescendantsSql = (
  selectedIds: readonly ProductCategoryId[],
) =>
  selectedIds.length === 0
    ? sql<ProductCategoryId>`(SELECT NULL::uuid WHERE false)`
    : sql<ProductCategoryId>`(
      WITH RECURSIVE descendants AS (
        SELECT c."id", ARRAY[c."id"] AS visited
        FROM "ProductCategory" c
        WHERE c."id" IN (${sql.join(
          selectedIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND c."deletedAt" IS NULL
        UNION ALL
        SELECT child."id", d.visited || child."id"
        FROM descendants d JOIN "ProductCategory" child ON child."parentId" = d."id"
        WHERE child."deletedAt" IS NULL AND array_length(d.visited, 1) < ${PRODUCT_CATEGORY_MAX_DEPTH}
          AND NOT child."id" = ANY(d.visited)
      ) SELECT "id" FROM descendants
    )`;

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
      'name', (SELECT "name" FROM ancestors ORDER BY depth LIMIT 1),
      'path', json_agg(json_build_object('id', "shortcode", 'name', "name") ORDER BY depth DESC),
      'feature', (SELECT "feature" FROM ancestors WHERE "feature" IS NOT NULL ORDER BY depth LIMIT 1)
    ) FROM ancestors
    HAVING count(*) > 0
  )`;
