import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  productBrandNameSql,
  productBrandCodeSql,
} from "~/server/db/computed/product-brand-sql";
import { categorySummarySql } from "~/server/db/computed/product-category-sql";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  entityExternalId as searchTableentityExternalId,
  product as searchTableproduct,
} from "~/server/db/schema";
import { product } from "~/server/db/schema";
import { loadAllGtins } from "~/server/domains/product/repo/gtin";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildProductEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(product),
        options.ids?.length
          ? inArray(
              product.id,
              options.ids.map((id) => parseEntityId("product", id)),
            )
          : undefined,
      ),
      extras: {
        brandName: productBrandNameSql(product.brandId).as("brandName"),
        brandCode: productBrandCodeSql(product.brandId).as("brandCode"),
        category: sql<
          string | null
        >`${categorySummarySql(sql`${product.categoryId}`)}->>${"name"}`.as(
          "category",
        ),
      },
      columns: {
        id: true,
        name: true,

        categoryId: true,
        model: true,
        notes: true,
        aliases: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.product.findMany(queryConfig);
  const gtins = await loadAllGtins(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    entityKind: "product",
    entityId: row.id,
    embeddingText: buildProductEmbeddingText({
      ...row,
      gtins: gtins.get(row.id) ?? [],
    }),
  }));
}
export const productSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.product}::text AS "entityKind", p."id"::text AS "entityId", p."shortcode",
        p."name" AS title, ${productBrandNameSql(sql`p."brandId"`)} AS subtitle, ${categorySummarySql(sql`p."categoryId"`)}->>${"name"} AS "typeHint",
        p."aliases" AS aliases,
        COALESCE((SELECT array_agg(pei."externalId") FROM "EntityExternalId" pei
                  WHERE pei."entityId" = p."id" AND pei."source" = 'gtin' AND ${notDeleted(alias(searchTableentityExternalId, "pei"))}),
                 ARRAY[]::text[]) || ARRAY[p."model", ${productBrandNameSql(sql`p."brandId"`)}]::text[] AS keywords
      FROM "Product" p WHERE ${notDeleted(alias(searchTableproduct, "p"))} AND ${entitySchema.enum.product} IN (${types}) AND ${requested(sql`p."id"`)} AND ${bounded(sql`p."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
