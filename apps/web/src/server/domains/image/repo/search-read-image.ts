import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { image as searchTableimage } from "~/server/db/schema";
import { image } from "~/server/db/schema";
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
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(image),
        options.ids?.length
          ? inArray(
              image.id,
              options.ids.map((id) => parseEntityId("image", id)),
            )
          : undefined,
      ),
      columns: { id: true, filename: true },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.image.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "image",
    entityId: row.id,
    embeddingText: row.filename,
  }));
}
export const imageSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.image}::text AS "entityKind", i."id"::text AS "entityId", i."shortcode",
        i.filename AS title, NULL::text AS subtitle, ${entitySchema.enum.image}::text AS "typeHint",
        ARRAY[]::text[] AS aliases, ARRAY[i."contentType"]::text[] AS keywords
      FROM "Image" i WHERE ${notDeleted(alias(searchTableimage, "i"))} AND ${entitySchema.enum.image} IN (${types}) AND ${requested(sql`i."id"`)} AND ${bounded(sql`i."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
