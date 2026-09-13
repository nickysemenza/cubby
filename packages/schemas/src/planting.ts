import { z } from "zod";

import { plantingShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { generatedPlantingFieldSchemas } from "./generated/entity-field-schemas.planting.gen";

export const plantingCreateInput = z.object(
  generatedPlantingFieldSchemas.create,
);
export const plantingUpdateData = z.object(
  generatedPlantingFieldSchemas.update,
);
export const plantingUpdateInput = z.object({
  id: plantingShortcode,
  data: plantingUpdateData,
});
export const plantingOut = z.object(generatedPlantingFieldSchemas.read);
export type PlantingOut = z.infer<typeof plantingOut>;
export const gardenPlantingOut = plantingOut.extend({
  ingredientName: z.string(),
  gardenGuideKey: z.string().nullable(),
  sourceProductName: z.string().nullable(),
  locationName: z.string().nullable(),
  intendedLocationName: z.string().nullable(),
});
export type GardenPlantingOut = z.infer<typeof gardenPlantingOut>;
export const plantingListItemOut = plantingOut.extend({});
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
