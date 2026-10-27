import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { categorySummarySql } from "~/server/db/computed/product-category-sql";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  entityExternalId as searchTableentityExternalId,
  product as searchTableproduct,
  location as searchTablelocation,
  inventoryEntry as searchTableinventoryEntry,
} from "~/server/db/schema";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { inventoryAmountSql } from "~/server/domains/inventory/repo/helpers";
import { loadAllGtins } from "~/server/domains/product/repo/gtin";
import {
  buildInventoryEmbeddingText,
  buildProductEmbeddingText,
} from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      amount: inventoryAmountSql,
      locationName: location.name,
      productName: product.name,
      brandName: productBrandNameSql(product.brandId),
      category: sql<
        string | null
      >`${categorySummarySql(sql`${product.categoryId}`)}->>${"name"}`,
      model: product.model,
      productId: product.id,
      notes: product.notes,
      aliases: product.aliases,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .innerJoin(location, eq(inventoryEntry.locationId, location.id))
    .where(
      and(
        notDeleted(inventoryEntry),
        notDeleted(product),
        notDeleted(location),
        options.ids?.length
          ? inArray(
              inventoryEntry.id,
              options.ids.map((id) => parseEntityId("inventory", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  const gtins = await loadAllGtins(
    db,
    rows.map((row) => row.productId),
  );

  return rows.map((row) => ({
    entityKind: "inventory",
    entityId: row.id,
    embeddingText: buildInventoryEmbeddingText({
      productText: buildProductEmbeddingText({
        name: row.productName,
        brandName: row.brandName,
        category: row.category,
        model: row.model,
        gtins: gtins.get(row.productId) ?? [],
        notes: row.notes,
        aliases: row.aliases,
      }),
      locationPath: row.locationName,
      amount: row.amount,
    }),
  }));
}
export const inventorySearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.inventory}, ie."id"::text, ie."shortcode", p."name", l."name", ${categorySummarySql(sql`p."categoryId"`)}->>${"name"}, p."aliases",
        ARRAY[l."name", l."type", ${productBrandNameSql(sql`p."brandId"`)}]::text[] ||
        COALESCE((SELECT array_agg(pei."externalId") FROM "EntityExternalId" pei
                  WHERE pei."entityId" = p."id" AND pei."source" = 'gtin' AND ${notDeleted(alias(searchTableentityExternalId, "pei"))}),
                 ARRAY[]::text[])
      FROM "InventoryEntry" ie JOIN "Product" p ON p."id" = ie."productId" AND ${notDeleted(alias(searchTableproduct, "p"))} JOIN "Location" l ON l."id" = ie."locationId" AND ${notDeleted(alias(searchTablelocation, "l"))}
      WHERE ${notDeleted(alias(searchTableinventoryEntry, "ie"))} AND ${entitySchema.enum.inventory} IN (${types}) AND ${requested(sql`ie."id"`)} AND ${bounded(sql`ie."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
