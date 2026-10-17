import { z } from "zod";

import { plantingShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import {
  gardenEntryBaseFilterFields,
  gardenEntryListItemOut,
} from "./generated/gardenEntry.gen";

export {
  gardenEntryCreateInput,
  gardenEntryUpdateData,
  gardenEntryUpdateInput,
  gardenEntryOut,
  gardenEntryListItemOut,
  type GardenEntryOut,
} from "./generated/gardenEntry.gen";

export const gardenEntryFilterFields = {
  ...gardenEntryBaseFilterFields,
  /**
   * A planting's journal: its own entries plus whole-location entries
   * observed during one of its confirmed location periods.
   */
  journalPlantingId: oneOrMany(plantingShortcode).optional(),
};
export const gardenEntryFiltersSchema = z.object(gardenEntryFilterFields);
export type GardenEntryFilters = z.infer<typeof gardenEntryFiltersSchema>;
export const gardenEntryListOut = createPaginatedResponseSchema(
  gardenEntryListItemOut,
);
