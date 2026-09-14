import { z } from "zod";

import { displayImagesField } from "./display-images";
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
/**
 * `gardenOverview` (`repo/garden/index.ts`) parses a raw joined select with no
 * `PlantingImage` relation loaded — `images` is omitted here rather than
 * inherited from `plantingOut` so that query's output keeps validating.
 */
export const gardenPlantingOut = plantingOut.omit({ images: true }).extend({
  ingredientName: z.string(),
  gardenGuideKey: z.string().nullable(),
  sourceProductName: z.string().nullable(),
  locationName: z.string().nullable(),
  intendedLocationName: z.string().nullable(),
});
export type GardenPlantingOut = z.infer<typeof gardenPlantingOut>;
/** List-row projection: `plantingOut` plus the server-resolved gallery cover(s). */
export const plantingListItemOut = plantingOut.extend({
  displayImages: displayImagesField,
});
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
