import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { wish as searchTablewish } from "~/server/db/schema";
import { entityLink, product, wish } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildWishEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
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
        notDeleted(wish),
        options.ids?.length
          ? inArray(
              wish.id,
              options.ids.map((id) => parseEntityId("wish", id)),
            )
          : undefined,
      ),
      columns: { id: true, name: true, notes: true },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.wish.findMany(queryConfig);
  const candidates =
    rows.length === 0
      ? []
      : await unwrapDb(db)
          .select({
            wishId: entityLink.fromEntityId,
            name: product.name,
            brandName: productBrandNameSql(product.brandId),
            model: product.model,
          })
          .from(entityLink)
          .innerJoin(product, eq(product.id, entityLink.toEntityId))
          .where(
            and(
              liveLinks("wishCandidate"),
              inArray(
                entityLink.fromEntityId,
                rows.map((row) => row.id),
              ),
            ),
          );
  return rows.map((row) => ({
    entityKind: "wish",
    entityId: row.id,
    embeddingText: buildWishEmbeddingText({
      name: row.name,
      notes: row.notes,
      candidateTerms: candidates
        .filter((candidate) => candidate.wishId === row.id)
        .flatMap((candidate) => [
          candidate.name,
          candidate.brandName,
          candidate.model,
        ]),
    }),
  }));
}
export const wishSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'wish', w."id"::text, w."shortcode", w."name", w."notes", 'tool wishlist', ARRAY[]::text[], ARRAY['tool wishlist']::text[]
      FROM "Wish" w WHERE ${notDeleted(alias(searchTablewish, "w"))} AND 'wish' IN (${types}) AND ${requested(sql`w."id"`)} AND ${bounded(sql`w."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
