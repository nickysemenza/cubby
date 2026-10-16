import { z } from "zod";

import { plainDate } from "./base-entity";
import { locationShortcode } from "./identifiers";
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
  activeOn: plainDate.optional(),
};
export const plantingFiltersSchema = z.object(plantingFilterFields);
export type PlantingFilters = z.infer<typeof plantingFiltersSchema>;
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
