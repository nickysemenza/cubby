import { planting } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadPlantingQualityRecords = qualityCheck.records("planting", planting, {
  status: planting.status,
  locationId: planting.locationId,
  sowedOn: planting.sowedOn,
  transplantedOn: planting.transplantedOn,
  finishedOn: planting.finishedOn,
  outcome: planting.outcome,
});

/** Bump when the rules or their declared scoring metadata change. */
const PLANTING_QUALITY_RULES_VERSION = 1;

type PlantingQualityRecord = Awaited<
  ReturnType<typeof loadPlantingQualityRecords>
>[number];
type PlantingDate = Date | string | null;

// A transplant from a nursery start never has a sow date of its own; either
// date marks when the planting began.
const dateValue = (value: Exclude<PlantingDate, null>) =>
  value instanceof Date ? value.getTime() : Date.parse(value);
const before = (left: PlantingDate, right: PlantingDate) =>
  left !== null && right !== null && dateValue(left) < dateValue(right);

export const plantingChecks = defineStoredEntityChecks({
  entity: "planting",
  table: planting,
  rulesVersion: PLANTING_QUALITY_RULES_VERSION,
  load: loadPlantingQualityRecords,
  checks: {
    planting_display_image: qualityCheck.hasImage,
    // A planned planting may have no assigned bed; active work must have one.
    planting_location: qualityCheck.when(
      (record: PlantingQualityRecord) => record.status !== "planned",
      qualityCheck.required("locationId"),
    ),
    planting_started: qualityCheck.when(
      (record: PlantingQualityRecord) => record.status !== "planned",
      qualityCheck.observed<PlantingQualityRecord>(
        (record) => record.sowedOn !== null || record.transplantedOn !== null,
      ),
    ),
    planting_finished: qualityCheck.when(
      (record: PlantingQualityRecord) => record.status === "finished",
      qualityCheck.observed<PlantingQualityRecord>(
        (record) => record.finishedOn !== null && record.outcome !== null,
      ),
    ),
    // Facts the status contradicts, or dates that run backwards.
    planting_lifecycle: qualityCheck.observed<PlantingQualityRecord>(
      (record) => {
        const hasFinishFacts =
          record.finishedOn !== null || record.outcome !== null;
        const startedOn = record.transplantedOn ?? record.sowedOn;
        return !(
          ((record.status === "planned" || record.status === "growing") &&
            hasFinishFacts) ||
          before(record.transplantedOn, record.sowedOn) ||
          before(record.finishedOn, startedOn)
        );
      },
    ),
  },
});
