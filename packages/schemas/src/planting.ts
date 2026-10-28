import { z } from "zod";

import { dateBound, dateRangeFields } from "./base-entity";
import { createPaginatedResponseSchema } from "./pagination";
import {
  plantingFilterFields as plantingBaseFilterFields,
  plantingListItemOut,
} from "@cubby/schemas/entities/planting";

export const plantingFilterFields = {
  ...plantingBaseFilterFields,
  activeOn: dateBound
    .optional()
    .describe("Plantings whose active span contains this day"),
  ...dateRangeFields("active", {
    describe: {
      from: "Plantings whose active span ends on or after this day",
      to: "Plantings whose active span starts on or before this day",
    },
  }),
};
export const plantingFiltersSchema = z.object(plantingFilterFields);
export type PlantingFilters = z.infer<typeof plantingFiltersSchema>;
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
