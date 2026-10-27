import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { shipment as searchTableshipment } from "~/server/db/schema";
import { shipment } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

const loadEmbeddingText = async (
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> => {
  const rows = await unwrapDb(db).query.shipment.findMany(
    withOptionalLimit(
      {
        columns: { id: true, name: true, trackingNumber: true, notes: true },
        where: and(
          notDeleted(shipment),
          options.ids?.length
            ? inArray(
                shipment.id,
                options.ids.map((id) => parseEntityId("shipment", id)),
              )
            : undefined,
        ),
      },
      options.limit,
    ),
  );
  return rows.map((row) => ({
    entityKind: "shipment",
    entityId: row.id,
    embeddingText: normalizeSearchText(
      [row.name, row.trackingNumber, row.notes].filter(Boolean).join(" "),
    ),
  }));
};
export const shipmentSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'shipment', s.id::text, s.shortcode, s.name, s."trackingNumber",
        s.purpose, ARRAY[]::text[], ARRAY[s.notes]::text[]
      FROM "Shipment" s WHERE ${notDeleted(alias(searchTableshipment, "s"))} AND 'shipment' IN (${types}) AND ${requested(sql`s.id`)} AND ${bounded(sql`s."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
