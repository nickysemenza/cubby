import {
  type ProductCategoryId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category";
import { PRODUCT_CATEGORY_MAX_DEPTH as MAX_PRODUCT_CATEGORY_DEPTH } from "@cubby/schemas/product-category-fields";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productCategory } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

/** The inherited behavior binding for one category; null means no binding. */
export async function getCategoryFeature(
  db: Database | DrizzleTransaction,
  categoryId: ProductCategoryId | null,
): Promise<ProductCategoryFeature | null> {
  if (!categoryId) return null;
  const rows = await unwrapDb(db).execute<{
    feature: ProductCategoryFeature | null;
  }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT c."id", c."parentId", c."feature", 0 AS depth, ARRAY[c."id"] AS visited
      FROM "ProductCategory" c WHERE c."id" = ${categoryId}::uuid AND c."deletedAt" IS NULL
      UNION ALL
      SELECT parent."id", parent."parentId", parent."feature", a.depth + 1, a.visited || parent."id"
      FROM ancestors a JOIN "ProductCategory" parent ON parent."id" = a."parentId"
      WHERE parent."deletedAt" IS NULL AND a.depth < ${MAX_PRODUCT_CATEGORY_DEPTH - 1}
        AND NOT parent."id" = ANY(a.visited)
    ) SELECT "feature" FROM ancestors WHERE "feature" IS NOT NULL ORDER BY depth LIMIT 1
  `);
  return rows.rows[0]?.feature ?? null;
}

/** SQL predicate: true only when the closest feature binding equals `feature`. */
/**
 * Keeps an already-selected compatible descendant. If none was selected (or it
 * belongs to another feature tree), selects the category bound to that feature.
 */
export async function resolveProductCategory(
  db: Database | DrizzleTransaction,
  requestedId: ProductCategoryId | null,
  requiredFeature: ProductCategoryFeature | null,
): Promise<ProductCategoryId | null> {
  if (
    requestedId &&
    (requiredFeature === null ||
      (await getCategoryFeature(db, requestedId)) === requiredFeature)
  ) {
    return requestedId;
  }
  if (requiredFeature === null) return null;
  const [root] = await unwrapDb(db)
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.feature, requiredFeature),
        notDeleted(productCategory),
      ),
    )
    .orderBy(asc(productCategory.sortOrder), asc(productCategory.name))
    .limit(1);
  return root ? parseEntityId("productCategory", root.id) : null;
}
