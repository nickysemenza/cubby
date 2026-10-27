import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { sourceTransactionRecord as searchTablesourceTransactionRecord } from "~/server/db/schema";
import { sourceTransactionRecord } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await unwrapDb(db).query.sourceTransactionRecord.findMany(
    withOptionalLimit(
      {
        columns: {
          id: true,
          source: true,
          rawDescription: true,
          merchant: true,
          accountDescriptor: true,
          sourceCategory: true,
          notes: true,
        },
        where: and(
          notDeleted(sourceTransactionRecord),
          options.ids?.length
            ? inArray(
                sourceTransactionRecord.id,
                options.ids.map((id) =>
                  parseEntityId("sourceTransactionRecord", id),
                ),
              )
            : undefined,
        ),
      },
      options.limit,
    ),
  );
  return rows.map((row) => ({
    entityKind: "sourceTransactionRecord",
    entityId: row.id,
    embeddingText: normalizeSearchText(
      [
        row.source,
        row.rawDescription,
        row.merchant,
        row.accountDescriptor,
        row.sourceCategory,
        row.notes,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  }));
}
export const sourceTransactionRecordSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'sourceTransactionRecord', r.id::text, r.shortcode,
        COALESCE(NULLIF(r."rawDescription", ''), r.merchant, r."accountDescriptor"), r."accountDescriptor",
        r.source, ARRAY[r."externalId"]::text[], ARRAY[r.merchant, r."sourceCategory", r.notes]::text[]
      FROM "SourceTransactionRecord" r WHERE ${notDeleted(alias(searchTablesourceTransactionRecord, "r"))} AND 'sourceTransactionRecord' IN (${types}) AND ${requested(sql`r.id`)} AND ${bounded(sql`r."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
