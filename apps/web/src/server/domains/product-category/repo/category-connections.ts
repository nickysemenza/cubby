import { categoryMappingSchema } from "@cubby/schemas/spending-classification";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  effectiveSourceSql,
  inheritanceLadderSql,
} from "~/server/db/computed/effective-field";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { productCategory } from "~/server/db/retained-tables";

/**
 * A category's spending mapping from its declared chain
 * (`resolution.inherit`): the deciding category, whether it maps, blocks
 * (an explicit None) or nothing decides, and the display path.
 */
export function categoryMappingSql(id: SQL): SQL {
  const source = effectiveSourceSql("productCategory", "spendingCategoryId", {
    id,
  });
  return sql`(SELECT jsonb_build_object(
      'state', CASE WHEN ih_m."spendingCategoryMode"='blocked' THEN 'blocked' WHEN ih_sc.id IS NULL THEN 'unmapped' WHEN (${source}->>'position')::int = 0 THEN 'direct' ELSE 'inherited' END,
      'category', CASE WHEN ih_sc.id IS NULL OR ih_m."spendingCategoryMode"='blocked' THEN NULL ELSE jsonb_build_object('id',ih_sc.shortcode,'name',ih_sc.name,'emoji',ih_sc.emoji) END,
      'source', CASE WHEN ih_m.id IS NULL THEN NULL ELSE jsonb_build_object('id',ih_m.shortcode,'name',ih_m.name) END,
      'path', (SELECT string_agg(ih_c.name,' > ' ORDER BY ih_l.depth DESC)
        FROM ${inheritanceLadderSql("productCategory", "spendingCategoryId", id)} ih_l JOIN "ProductCategory" ih_c ON ih_c.id = ih_l.id))
    FROM (VALUES(1)) ih_seed(n)
    LEFT JOIN "ProductCategory" ih_m ON ih_m.id = (${source}->>'id')::uuid
    LEFT JOIN "SpendingCategory" ih_sc ON ih_sc.id=ih_m."spendingCategoryId" AND ${notDeleted("ih_sc")} AND ih_m."spendingCategoryMode"='mapped')`;
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
