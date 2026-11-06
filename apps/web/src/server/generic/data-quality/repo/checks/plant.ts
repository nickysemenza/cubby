import { plant } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadPlantQualityRecords = qualityCheck.records("plant", plant, {
  gardenGuideKey: plant.gardenGuideKey,
});

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
