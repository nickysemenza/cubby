import { gardenEntryKind } from "@cubby/schemas/garden-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  planting as searchTableplanting,
  plant as searchTableplant,
  entityLink as searchTableentityLink,
  location as searchTablelocation,
  gardenEntry as searchTablegardenEntry,
} from "~/server/db/schema";
import { entityLink, gardenEntry, plant, planting } from "~/server/db/schema";
import { plantingDisplayName } from "~/server/domains/plant/repo/windows";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildGardenEntryEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

const GARDEN_ENTRY_KIND_LABEL = {
  note: "Note",
  harvest: "Harvest",
} satisfies Record<string, string>;
function isGardenEntryKindLabel(
  kind: string,
): kind is keyof typeof GARDEN_ENTRY_KIND_LABEL {
  return kind in GARDEN_ENTRY_KIND_LABEL;
}

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(gardenEntry),
        options.ids?.length
          ? inArray(
              gardenEntry.id,
              options.ids.map((id) => parseEntityId("gardenEntry", id)),
            )
          : undefined,
      ),
      columns: {
        id: true,
        kind: true,
        observedOn: true,
        notes: true,
        harvestAmount: true,
      },
      with: {
        location: { columns: { name: true } },
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.gardenEntry.findMany(queryConfig);
  const linked =
    rows.length === 0
      ? []
      : await unwrapDb(db)
          .select({
            entryId: entityLink.fromEntityId,
            plantName: plant.name,
            gardenGuideKey: plant.gardenGuideKey,
          })
          .from(entityLink)
          .innerJoin(planting, eq(planting.id, entityLink.toEntityId))
          .leftJoin(plant, eq(plant.id, planting.plantId))
          .where(
            and(
              liveLinks("gardenEntryPlanting"),
              inArray(
                entityLink.fromEntityId,
                rows.map((row) => row.id),
              ),
            ),
          );
  return rows.map((row) => ({
    entityKind: "gardenEntry",
    entityId: row.id,
    embeddingText: buildGardenEntryEmbeddingText({
      kindLabel: isGardenEntryKindLabel(row.kind)
        ? GARDEN_ENTRY_KIND_LABEL[row.kind]
        : "Move",
      observedOn: row.observedOn,
      locationName: row.location.name,
      plantingName:
        linked
          .filter((link) => link.entryId === row.id)
          .map((link) =>
            plantingDisplayName(
              link.plantName === null
                ? null
                : { name: link.plantName, gardenGuideKey: link.gardenGuideKey },
            ),
          )
          .join(", ") || null,
      note: row.notes,
      harvestAmount: row.harvestAmount,
    }),
  }));
}
export const gardenEntrySearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT 'gardenEntry', ge."id"::text, ge."shortcode",
        (CASE ge."kind" WHEN ${gardenEntryKind.enum.note} THEN 'Note' WHEN ${gardenEntryKind.enum.harvest} THEN 'Harvest' ELSE 'Move' END)
          || ' · ' || to_char(ge."observedOn", 'YYYY-MM-DD') || ' · ' || l."name",
        (SELECT string_agg(COALESCE(p."name", 'Unknown plant'), ', ' ORDER BY pl."shortcode")
         FROM "EntityLink" gep
         JOIN "Planting" pl ON pl."id" = gep."toEntityId" AND ${notDeleted(alias(searchTableplanting, "pl"))}
         LEFT JOIN "Plant" p ON p."id" = pl."plantId" AND ${notDeleted(alias(searchTableplant, "p"))}
         WHERE gep."fromEntityId" = ge."id" AND ${notDeleted(alias(searchTableentityLink, "gep"))} AND gep."kind" = 'gardenEntryPlanting'),
        ge."kind", ARRAY[]::text[], ARRAY[l."name", ge."harvestAmount"]::text[]
      FROM "GardenEntry" ge
      JOIN "Location" l ON l."id" = ge."locationId" AND ${notDeleted(alias(searchTablelocation, "l"))}
      WHERE ${notDeleted(alias(searchTablegardenEntry, "ge"))} AND 'gardenEntry' IN (${types}) AND ${requested(sql`ge."id"`)} AND ${bounded(sql`ge."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
