import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { vendor as searchTablevendor } from "~/server/db/schema";
import { vendor } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildVendorEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
        notDeleted(vendor),
        options.ids?.length
          ? inArray(
              vendor.id,
              options.ids.map((id) => parseEntityId("vendor", id)),
            )
          : undefined,
      ),
      columns: { id: true, name: true, website: true, notes: true },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.vendor.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "vendor",
    entityId: row.id,
    embeddingText: buildVendorEmbeddingText(row),
  }));
}
export const vendorSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.vendor}, v."id"::text, v."shortcode", v."name", v."website", NULL, ARRAY[]::text[], ARRAY[v."website"]::text[]
      FROM "Vendor" v WHERE ${notDeleted(alias(searchTablevendor, "v"))} AND ${entitySchema.enum.vendor} IN (${types}) AND ${requested(sql`v."id"`)} AND ${bounded(sql`v."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
