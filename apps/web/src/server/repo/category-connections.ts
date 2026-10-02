import { categoryMappingSchema } from "@cubby/schemas/spending-classification";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productCategory } from "~/server/db/schema";

import { notDeleted, unwrapDb } from "./database-helpers";
import { productCategorySpendingAncestorsSql } from "./expense-category-resolution";

export function categoryMappingSql(id: SQL): SQL {
  return sql`(WITH RECURSIVE ancestors AS (${productCategorySpendingAncestorsSql(id)}),
    mapping AS (SELECT * FROM ancestors WHERE "spendingCategoryMode" <> 'inherit' ORDER BY depth LIMIT 1)
    SELECT jsonb_build_object(
      'state', CASE WHEN m."spendingCategoryMode"='blocked' THEN 'blocked' WHEN sc.id IS NULL THEN 'unmapped' WHEN m.depth=0 THEN 'direct' ELSE 'inherited' END,
      'category', CASE WHEN sc.id IS NULL OR m."spendingCategoryMode"='blocked' THEN NULL ELSE jsonb_build_object('id',sc.shortcode,'name',sc.name,'emoji',sc.emoji) END,
      'source', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id',m.shortcode,'name',m.name) END,
      'path', (SELECT string_agg(name,' > ' ORDER BY depth DESC) FROM ancestors))
    FROM (VALUES(1)) seed(n) LEFT JOIN mapping m ON TRUE
    LEFT JOIN "SpendingCategory" sc ON sc.id=m."spendingCategoryId" AND sc."deletedAt" IS NULL)`;
}

export async function loadCategoryConnections(
  db: Database | DrizzleTransaction,
  ids?: readonly (typeof productCategory.$inferSelect.id)[],
) {
  if (ids?.length === 0)
    return new Map<string, z.infer<typeof categoryMappingSchema>>();
  const rows = await unwrapDb(db)
    .select({
      id: productCategory.id,
      mapping: categoryMappingSql(sql`${productCategory.id}`),
    })
    .from(productCategory)
    .where(
      and(
        notDeleted(productCategory),
        ids ? inArray(productCategory.id, [...ids]) : undefined,
      ),
    );
  return new Map(
    rows.map((row) => [row.id, categoryMappingSchema.parse(row.mapping)]),
  );
}
