import { entitySchema } from "@cubby/schemas/entity";
import { fieldResolutionEvaluationSchema } from "@cubby/schemas/field-resolution";
import {
  PRODUCT_CATEGORY_MAX_DEPTH,
  type ProductCategorySummary,
} from "@cubby/schemas/product-category-fields";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import {
  effectiveFieldSql,
  effectiveSourceSql,
  inheritanceLadderSql,
  inheritedFieldSql,
  inheritedSourceSql,
} from "~/server/db/computed/effective-field";

/** Constants below are inlined with `sql.raw` (not `.inlineParams()`): under the
 * relational `extras` API (`db.query.product.findFirst({ extras: {...} })`),
 * drizzle's `mapColumnsInSQLToAlias` (alias.js) rebuilds nested SQL via
 * `sql.join(...)`, which silently drops `.inlineParams()`'s inline flag and binds
 * the value as a parameter instead — breaking the requirement below that repeated
 * SELECT/GROUP BY expressions stay textually identical. Both values are
 * compile-time literals: the depth is a module constant. */
const MAX_ANCESTOR_DEPTH = sql.raw(String(PRODUCT_CATEGORY_MAX_DEPTH - 1));

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
      'feature', ${effectiveFieldSql("productCategory", "feature", { id: categoryIdExpr })}
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

/** The effective decision at or above a category, the category that made
 * it, and every category the chain reads, for page-bounded reads that
 * explain the value. `inherited` reads what the category would inherit
 * instead (its own decision ignored, the ladder from its parent), along the
 * category's own capped chain, so a category's provenance agrees with its
 * value. Inner aliases are `ih_`-prefixed so a caller's correlated
 * `categoryIdExpr` is never shadowed. */
export const categoryStockTrackingSql = (
  categoryIdExpr: SQL,
  { inherited = false }: { inherited?: boolean } = {},
) => {
  const row = { id: categoryIdExpr };
  const source = inherited
    ? inheritedSourceSql("productCategory", "stockTracked", row)
    : effectiveSourceSql("productCategory", "stockTracked", row);
  const value = inherited
    ? inheritedFieldSql("productCategory", "stockTracked", row)
    : effectiveFieldSql("productCategory", "stockTracked", row);
  const minDepth = sql.raw(inherited ? "1" : "0");
  const ladder = inheritanceLadderSql(
    "productCategory",
    "stockTracked",
    categoryIdExpr,
  );
  const decider = (column: "shortcode" | "name") =>
    sql`(SELECT ih_pd.${sql.identifier(column)} FROM "ProductCategory" ih_pd WHERE ih_pd."id" = (${source}->>'id')::uuid)`;
  return sql<CategoryStockTracking | null>`(
    SELECT jsonb_build_object(
      'value', ${value},
      'id', ${decider("shortcode")},
      ${"name"}::text, ${decider("name")},
      ${"evaluation"}::text, (SELECT jsonb_agg(jsonb_build_object('entityKind', ${entitySchema.enum.productCategory}::text, 'entityId', ih_pc."shortcode", ${"name"}::text, ih_pc."name", 'value', l."value", ${"assigned"}::text, l."decides") ORDER BY l."depth")
        FROM ${ladder} l JOIN "ProductCategory" ih_pc ON ih_pc."id" = l."id" WHERE l."depth" >= ${minDepth})
    ) WHERE EXISTS (SELECT 1 FROM ${ladder} ih_pe WHERE ih_pe."depth" >= ${minDepth})
  )`;
};
