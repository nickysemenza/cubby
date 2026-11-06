import { gardenEntry } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadGardenEntryQualityRecords = qualityCheck.records(
  "gardenEntry",
  gardenEntry,
  {
    kind: gardenEntry.kind,
    notes: gardenEntry.notes,
    harvestAmount: gardenEntry.harvestAmount,
  },
);

/** Bump when the rules or their declared scoring metadata change. */
const GARDEN_ENTRY_QUALITY_RULES_VERSION = 1;

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
