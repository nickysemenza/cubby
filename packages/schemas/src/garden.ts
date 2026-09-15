import { z } from "zod";

import {
  imageShortcode,
  ingredientShortcode,
  locationShortcode,
  plantingShortcode,
  productShortcode,
} from "./identifiers";
import { plainDate } from "./base-entity";
import { gardenEntryOut } from "./garden-entry";
import { gardenPlantingOut } from "./planting";
export {
  gardenEntryKind,
  gardenLocationKind,
  plantingLocationStartKind,
  plantingStatus,
} from "./garden-fields";
import {
  gardenLocationKind,
  plantingLocationStartKind,
  plantingStatus,
} from "./garden-fields";

export {
  gardenEntryCreateInput,
  gardenEntryListItemOut,
  gardenEntryListOut,
  gardenEntryOut,
  gardenEntryUpdateData,
  gardenEntryUpdateInput,
  type GardenEntryOut,
} from "./garden-entry";
export {
  gardenPlantingOut,
  plantingCreateInput,
  plantingListItemOut,
  plantingListOut,
  plantingOut,
  plantingUpdateData,
  plantingUpdateInput,
  type GardenPlantingOut,
  type PlantingOut,
} from "./planting";

const optionalPlantingDetails = {
  sourceProductId: productShortcode.nullable().optional(),
  variety: z.string().trim().min(1).nullable().optional(),
  quantity: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
  plannedWindow: z.string().trim().min(1).nullable().optional(),
  plannedDate: plainDate.nullable().optional(),
  sowedOn: plainDate.nullable().optional(),
  transplantedOn: plainDate.nullable().optional(),
};

export const gardenCreatePlantingInput = z.object({
  ingredientId: ingredientShortcode,
  locationId: locationShortcode.nullable().optional(),
  intendedLocationId: locationShortcode.nullable().optional(),
  status: plantingStatus.default("planned"),
  inLocationSince: plainDate.nullable().optional(),
  inLocationSinceKind: plantingLocationStartKind.default("actual"),
  ...optionalPlantingDetails,
});
export const gardenRecordEntryInput = z.object({
  locationId: locationShortcode,
  plantingId: plantingShortcode.nullable().optional(),
  kind: z.enum(["observation", "harvest"]).default("observation"),
  observedOn: plainDate,
  note: z.string().trim().min(1).nullable().optional(),
  harvestAmount: z.string().trim().min(1).nullable().optional(),
  pendingImageIds: z.array(imageShortcode).max(20).default([]),
});
export const gardenStartPlantingInput = z.object({
  plantingId: plantingShortcode,
  locationId: locationShortcode,
  startedOn: plainDate,
  startMethod: z.enum(["sow", "transplant", "existing"]),
});
export const gardenMovePlantingInput = z.object({
  plantingId: plantingShortcode,
  locationId: locationShortcode,
  movedOn: plainDate,
  note: z.string().trim().min(1).nullable().optional(),
});
export const gardenSplitPlantingInput = z.object({
  plantingId: plantingShortcode,
  locationId: locationShortcode,
  movedOn: plainDate,
  quantity: z.string().trim().min(1).nullable().optional(),
  note: z.string().trim().min(1).nullable().optional(),
});
export const gardenFinishPlantingInput = z.object({
  plantingId: plantingShortcode,
  finishedOn: plainDate,
  note: z.string().trim().min(1).nullable().optional(),
});
export const gardenEntriesInput = z.object({
  locationId: locationShortcode.optional(),
  plantingId: plantingShortcode.optional(),
  page: z.number().int().positive().default(1),
});
export const gardenEntriesOut = z.object({
  items: z.array(gardenEntryOut),
  hasMore: z.boolean(),
});

export const gardenJournalInput = z.object({
  plantingId: plantingShortcode,
  includeBedContext: z.boolean().default(false),
  page: z.number().int().positive().default(1),
});
export const gardenJournalEntryOut = gardenEntryOut.extend({
  context: z.enum(["direct", "bed"]),
});
export const gardenJournalOut = z.object({
  items: z.array(gardenJournalEntryOut),
  hasMore: z.boolean(),
});

// `search` is name-prefix matched (2+ chars after trim; shorter is ignored)
// against Locations/Ingredients/Products beyond the default garden-scoped
// set — see `garden.options` in docs/garden.md.
// Stays a flat GET query (`?search=`): an optional *object* would force a POST
// body and drop the operation out of the native client's GET/list filter.
export const gardenOptionsInput = z.object({
  search: z.string().optional(),
});

export const gardenLocationHistoryInput = z.object({
  plantingId: plantingShortcode,
});
export const gardenLocationPeriodOut = z.object({
  sequence: z.number().int().nonnegative(),
  locationId: locationShortcode,
  locationName: z.string(),
  inLocationSince: plainDate,
  endedOn: plainDate.nullable(),
  startKind: plantingLocationStartKind,
});
export const gardenLocationHistoryOut = z.object({
  periods: z.array(gardenLocationPeriodOut),
});
export const gardenCorrectLocationDatesInput = z.object({
  plantingId: plantingShortcode,
  periods: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      inLocationSince: plainDate,
      endedOn: plainDate.nullable().optional(),
    }),
  ),
});

export const gardenLocationSummaryOut = z.object({
  id: locationShortcode,
  name: z.string(),
  gardenKind: gardenLocationKind.nullable(),
  gardenConditions: z.string().nullable(),
  plantings: z.array(gardenPlantingOut),
});
export const gardenOverviewOut = z.object({
  locations: z.array(gardenLocationSummaryOut),
  finished: z.array(gardenPlantingOut),
  unassigned: z.array(gardenPlantingOut),
});
export const gardenOptionsOut = z.object({
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
      gardenKind: gardenLocationKind.nullable(),
      gardenConditions: z.string().nullable(),
    }),
  ),
  ingredients: z.array(
    z.object({
      id: ingredientShortcode,
      name: z.string(),
      gardenGuideKey: z.string().nullable(),
    }),
  ),
  products: z.array(
    z.object({
      id: productShortcode,
      name: z.string(),
      growsIngredientId: ingredientShortcode.nullable(),
    }),
  ),
  plantings: z.array(
    z.object({
      id: plantingShortcode,
      name: z.string(),
      locationId: locationShortcode.nullable(),
      locationName: z.string().nullable(),
      status: plantingStatus,
    }),
  ),
});
