import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { gardenEntry } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const GARDEN_ENTRY_QUALITY_RULES_VERSION = 1;

type GardenEntryQualityRecord = Awaited<
  ReturnType<typeof loadGardenEntryQualityRecords>
>[number];

export const gardenEntryChecks = defineStoredEntityChecks({
  entity: "gardenEntry",
  table: gardenEntry,
  rulesVersion: GARDEN_ENTRY_QUALITY_RULES_VERSION,
  load: loadGardenEntryQualityRecords,
  checks: {
    gardenentry_display_image: qualityCheck.hasImage,
    garden_entry_note: qualityCheck.when(
      (record: GardenEntryQualityRecord) => record.kind === "note",
      qualityCheck.required("notes"),
    ),
    garden_entry_harvest_amount: qualityCheck.when(
      (record: GardenEntryQualityRecord) => record.kind === "harvest",
      qualityCheck.required("harvestAmount"),
    ),
  },
});

async function loadGardenEntryQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: gardenEntry.id,
      shortcode: gardenEntry.shortcode,
      kind: gardenEntry.kind,
      notes: gardenEntry.notes,
      harvestAmount: gardenEntry.harvestAmount,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("gardenEntry", sql`${gardenEntry.id}`)}`,
    })
    .from(gardenEntry)
    .where(
      and(
        notDeleted(gardenEntry),
        sql`${gardenEntry.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
