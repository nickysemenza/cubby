import { z } from "zod";

import { plainDate } from "./base-entity";
import {
  gardenEntryShortcode,
  plantShortcode,
  locationShortcode,
  productShortcode,
  taskShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import {
  plantingBaseFilterFields,
  plantingListItemOut,
} from "./generated/planting.gen";

export {
  plantingCreateInput,
  plantingUpdateData,
  plantingUpdateInput,
  plantingOut,
  plantingListItemOut,
  type PlantingOut,
} from "./generated/planting.gen";

export const plantingFilterFields = {
  ...plantingBaseFilterFields,
  locationId: oneOrMany(locationShortcode).optional(),
  plantId: oneOrMany(plantShortcode).optional(),
  taskId: oneOrMany(taskShortcode).optional(),
  sourceProductId: oneOrMany(productShortcode).optional(),
  /** Plantings a garden entry is logged against (`GardenEntryPlanting`). */
  gardenEntryId: oneOrMany(gardenEntryShortcode).optional(),
  activeOn: plainDate.optional(),
};
export const plantingFiltersSchema = z.object(plantingFilterFields);
export type PlantingFilters = z.infer<typeof plantingFiltersSchema>;
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
