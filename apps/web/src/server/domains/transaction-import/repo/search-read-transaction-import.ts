import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { transactionImport as searchTabletransactionImport } from "~/server/db/schema";
import { transactionImport } from "~/server/db/schema";
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
  const rows = await unwrapDb(db).query.transactionImport.findMany(
    withOptionalLimit(
      {
        columns: {
          id: true,
          source: true,
          label: true,
          fingerprint: true,
          notes: true,
        },
        where: and(
          notDeleted(transactionImport),
          options.ids?.length
            ? inArray(
                transactionImport.id,
                options.ids.map((id) => parseEntityId("transactionImport", id)),
              )
            : undefined,
        ),
      },
      options.limit,
    ),
  );
  return rows.map((row) => ({
    entityKind: "transactionImport",
    entityId: row.id,
    embeddingText: normalizeSearchText(
      [row.source, row.label, row.fingerprint, row.notes]
        .filter(Boolean)
        .join(" "),
    ),
  }));
}
export const transactionImportSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'transactionImport', i.id::text, i.shortcode, i.label, i.fingerprint,
        i.source, ARRAY[]::text[], ARRAY[i.notes]::text[]
      FROM "TransactionImport" i WHERE ${notDeleted(alias(searchTabletransactionImport, "i"))} AND 'transactionImport' IN (${types}) AND ${requested(sql`i.id`)} AND ${bounded(sql`i."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
