import { z } from "zod";

import { auditDateFilterFields } from "./base-entity";
import {
  gardenEntryShortcode,
  locationShortcode,
  plantingShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import {
  generatedGardenEntryFieldSchemas,
  generatedGardenEntryFilterFields,
} from "./generated/entity-field-schemas.gardenEntry.gen";
import { displayImagesField } from "./display-images";

export const gardenEntryCreateInput = z.object(
  generatedGardenEntryFieldSchemas.create,
);
export const gardenEntryUpdateData = z.object(
  generatedGardenEntryFieldSchemas.update,
);
export const gardenEntryUpdateInput = z.object({
  id: gardenEntryShortcode,
  data: gardenEntryUpdateData,
});
export const gardenEntryFilterFields = {
  ...auditDateFilterFields,
  ...generatedGardenEntryFilterFields,
  locationId: oneOrMany(locationShortcode).optional(),
  plantingId: oneOrMany(plantingShortcode).optional(),
  /**
   * A planting's journal: its own entries plus whole-location entries
   * observed during one of its confirmed location periods.
   */
  journalPlantingId: plantingShortcode.optional(),
};
export const gardenEntryFiltersSchema = z.object(gardenEntryFilterFields);
export type GardenEntryFilters = z.infer<typeof gardenEntryFiltersSchema>;
export const gardenEntryOut = z.object(generatedGardenEntryFieldSchemas.read);
export type GardenEntryOut = z.infer<typeof gardenEntryOut>;
export const gardenEntryListItemOut = gardenEntryOut.extend({
  displayImages: displayImagesField,
});
export const gardenEntryListOut = createPaginatedResponseSchema(
  gardenEntryListItemOut,
);
