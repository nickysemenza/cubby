import { z } from "zod";

import { plantingShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import {
  gardenEntryFilterFields as gardenEntryBaseFilterFields,
  gardenEntryListItemOut,
} from "@cubby/schemas/entities/gardenEntry";

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
