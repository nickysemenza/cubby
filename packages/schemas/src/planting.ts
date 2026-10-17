import { z } from "zod";

import { plainDate } from "./base-entity";
import { createPaginatedResponseSchema } from "./pagination";
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
  activeOn: plainDate.optional(),
};
export const plantingFiltersSchema = z.object(plantingFilterFields);
export type PlantingFilters = z.infer<typeof plantingFiltersSchema>;
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
