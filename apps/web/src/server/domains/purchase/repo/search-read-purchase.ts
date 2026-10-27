import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  vendor as searchTablevendor,
  purchase as searchTablepurchase,
} from "~/server/db/schema";
import { purchase, vendor } from "~/server/db/schema";
import { buildPurchaseEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
      id: purchase.id,
      vendorName: vendor.name,
      orderId: purchase.orderId,
      displayLabel: purchase.displayLabel,
      date: purchase.date,
      notes: purchase.notes,
    })
    .from(purchase)
    .innerJoin(
      vendor,
      and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)),
    )
    .where(
      and(
        notDeleted(purchase),
        options.ids?.length
          ? inArray(
              purchase.id,
              options.ids.map((id) => parseEntityId("purchase", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityKind: "purchase",
    entityId: row.id,
    embeddingText: buildPurchaseEmbeddingText(row),
  }));
}
export const purchaseSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.purchase}, pu."id"::text, pu."shortcode", COALESCE(NULLIF(pu."orderId", ''), concat_ws(' · ', v."name", pu."date"::text)), v."name", NULL, ARRAY[]::text[], ARRAY[pu."orderId", pu."displayLabel", pu."notes", v."name", v."website", pu."date"::text]::text[]
      FROM "Purchase" pu JOIN "Vendor" v ON v."id" = pu."vendorId" AND ${notDeleted(alias(searchTablevendor, "v"))}
      WHERE ${notDeleted(alias(searchTablepurchase, "pu"))} AND ${entitySchema.enum.purchase} IN (${types}) AND ${requested(sql`pu."id"`)} AND ${bounded(sql`pu."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
