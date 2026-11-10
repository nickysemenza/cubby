import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { cookbook as searchTablecookbook } from "~/server/db/schema";
import { cookbook } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildCookbookEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(
              notDeleted(cookbook),
              options.ids?.length
                ? inArray(
                    cookbook.id,
                    options.ids.map((id) => parseEntityId("cookbook", id)),
                  )
                : undefined,
            ),
          ),
      },
      columns: {
        id: true,
        name: true,
        author: true,
        subjects: true,
        sourceLabel: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.cookbook.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "cookbook",
    entityId: row.id,
    embeddingText: buildCookbookEmbeddingText(row),
  }));
}
export const cookbookSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'cookbook', c."id"::text, c."shortcode", c."name", NULLIF(array_to_string(c."author", ', '), ''), NULL, ARRAY[]::text[], c."subjects"
      FROM "Cookbook" c WHERE ${notDeleted(alias(searchTablecookbook, "c"))} AND 'cookbook' IN (${types}) AND ${requested?.match({ entity: "cookbook", id: sql`c."id"` }) ?? sql`TRUE`} AND ${bounded(sql`c."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
