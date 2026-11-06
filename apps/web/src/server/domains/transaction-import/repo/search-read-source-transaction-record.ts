import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { sourceTransactionRecord as searchTablesourceTransactionRecord } from "~/server/db/schema";
import { sourceTransactionRecord } from "~/server/db/schema";
import {
  sourceObservationColumns,
  sourceObservationFacts,
} from "~/server/domains/transaction-import/repo/source-observation-state";
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
      id: sourceObservationColumns.id,
      source: sourceObservationColumns.source,
      rawDescription: sourceObservationColumns.rawDescription,
      merchant: sourceObservationColumns.merchant,
      accountDescriptor: sourceObservationColumns.accountDescriptor,
      sourceCategory: sourceObservationColumns.sourceCategory,
      notes: sourceObservationColumns.notes,
    })
    .from(sql`${sourceObservationFacts} "SourceTransactionRecord"`)
    .where(
      and(
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
    );
  const rows = await (options.limit === undefined
    ? query
    : query.limit(options.limit));
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
      FROM ${sourceObservationFacts} r WHERE ${notDeleted(alias(searchTablesourceTransactionRecord, "r"))} AND 'sourceTransactionRecord' IN (${types}) AND ${requested(sql`r.id`)} AND ${bounded(sql`r."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
