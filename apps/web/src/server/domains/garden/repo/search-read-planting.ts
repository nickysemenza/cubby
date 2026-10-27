import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  plant as searchTableplant,
  location as searchTablelocation,
  planting as searchTableplanting,
} from "~/server/db/schema";
import { planting } from "~/server/db/schema";
import { plantingDisplayName } from "~/server/domains/plant/repo/windows";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildPlantingEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
        notDeleted(planting),
        options.ids?.length
          ? inArray(
              planting.id,
              options.ids.map((id) => parseEntityId("planting", id)),
            )
          : undefined,
      ),
      columns: { id: true, status: true, notes: true },
      with: {
        plant: { columns: { name: true, gardenGuideKey: true } },
        location: { columns: { name: true } },
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.planting.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "planting",
    entityId: row.id,
    embeddingText: buildPlantingEmbeddingText({
      plantName: plantingDisplayName(row.plant),
      status: row.status,
      locationName: row.location?.name ?? null,
      notes: row.notes,
    }),
  }));
}
export const plantingSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.planting}, pl."id"::text, pl."shortcode",
        COALESCE(p."name", 'Unknown plant'),
        concat_ws(' · ', pl."status", l."name"), pl."status",
        ARRAY[]::text[], ARRAY[p."gardenGuideKey", l."name"]::text[]
      FROM "Planting" pl
      LEFT JOIN "Plant" p ON p."id" = pl."plantId" AND ${notDeleted(alias(searchTableplant, "p"))}
      LEFT JOIN "Location" l ON l."id" = pl."locationId" AND ${notDeleted(alias(searchTablelocation, "l"))}
      WHERE ${notDeleted(alias(searchTableplanting, "pl"))} AND ${entitySchema.enum.planting} IN (${types}) AND ${requested(sql`pl."id"`)} AND ${bounded(sql`pl."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
