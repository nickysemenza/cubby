import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { locationAiDescriptionExtras } from "~/server/db/computed/location-ai-description";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { location as searchTablelocation } from "~/server/db/schema";
import { location } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildLocationEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
        notDeleted(location),
        options.ids?.length
          ? inArray(
              location.id,
              options.ids.map((id) => parseEntityId("location", id)),
            )
          : undefined,
      ),
      columns: {
        id: true,
        name: true,
        type: true,
        aliases: true,
      },
      extras: locationAiDescriptionExtras,
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.location.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "location",
    entityId: row.id,
    embeddingText: buildLocationEmbeddingText(row),
  }));
}
export const locationSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.location}, l."id"::text, l."shortcode", l."name",
        (SELECT string_agg(path.name, ' › ' ORDER BY path.depth DESC) FROM location_path path WHERE path."rootId" = l.id AND path.depth > 0),
        l."type", l."aliases", ARRAY[l."type"]::text[]
      FROM "Location" l WHERE ${notDeleted(alias(searchTablelocation, "l"))} AND ${entitySchema.enum.location} IN (${types}) AND ${requested(sql`l."id"`)} AND ${bounded(sql`l."createdAt"`)}`,
  prefix: ({ types, requested }) => sql`WITH RECURSIVE location_path AS (
 SELECT l.id AS "rootId", l.id, l."parentId", l.name, 0 AS depth FROM "Location" l
 WHERE ${entitySchema.enum.location} IN (${types}) AND ${requested(sql`l."id"`)} AND ${notDeleted(alias(searchTablelocation, "l"))}
 UNION ALL SELECT child."rootId", parent.id, parent."parentId", parent.name, child.depth + 1 FROM "Location" parent JOIN location_path child ON child."parentId" = parent.id WHERE ${notDeleted(alias(searchTablelocation, "parent"))}
 )`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
