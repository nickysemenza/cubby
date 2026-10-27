import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { plant as searchTableplant } from "~/server/db/schema";
import { plant } from "~/server/db/schema";
import { plantDisplayName } from "~/server/domains/plant/repo/windows";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildPlantEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
        notDeleted(plant),
        options.ids?.length
          ? inArray(
              plant.id,
              options.ids.map((id) => parseEntityId("plant", id)),
            )
          : undefined,
      ),
      columns: {
        id: true,
        name: true,
        gardenGuideKey: true,
        latinName: true,
        verdict: true,
        notes: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.plant.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "plant",
    entityId: row.id,
    embeddingText: buildPlantEmbeddingText({
      displayName: plantDisplayName(row.name, row.gardenGuideKey),
      latinName: row.latinName,
      verdict: row.verdict,
      notes: row.notes,
    }),
  }));
}
export const plantSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'plant', p."id"::text, p."shortcode", p."name",
        concat_ws(' · ', p."gardenGuideKey", p."verdict"), p."verdict",
        ARRAY[]::text[], ARRAY[p."gardenGuideKey", p."latinName"]::text[]
      FROM "Plant" p
      WHERE ${notDeleted(alias(searchTableplant, "p"))} AND 'plant' IN (${types}) AND ${requested(sql`p."id"`)} AND ${bounded(sql`p."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
