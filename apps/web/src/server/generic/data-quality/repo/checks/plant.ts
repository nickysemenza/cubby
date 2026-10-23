import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { plant } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const PLANT_QUALITY_RULES_VERSION = 1;

type PlantQualityRecord = Awaited<
  ReturnType<typeof loadPlantQualityRecords>
>[number];

export const plantChecks = defineStoredEntityChecks({
  entity: "plant",
  table: plant,
  rulesVersion: PLANT_QUALITY_RULES_VERSION,
  load: loadPlantQualityRecords,
  checks: {
    plant_display_image: qualityCheck.hasImage,
    // Keep the SQL rule's null-only meaning; empty keys are not a separate gap.
    plant_crop: qualityCheck.observed<PlantQualityRecord>(
      (record) => record.gardenGuideKey !== null,
    ),
  },
});

async function loadPlantQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: plant.id,
      shortcode: plant.shortcode,
      gardenGuideKey: plant.gardenGuideKey,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("plant", sql`${plant.id}`)}`,
    })
    .from(plant)
    .where(
      and(notDeleted(plant), sql`${plant.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
