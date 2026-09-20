import { z } from "zod";

import { auditDateFilterFields, plainDate } from "./base-entity";
import { displayImagesField } from "./display-images";
import {
  ingredientShortcode,
  locationShortcode,
  plantingShortcode,
  productShortcode,
  taskShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import {
  generatedPlantingFieldSchemas,
  generatedPlantingFilterFields,
} from "./generated/entity-field-schemas.planting.gen";

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
export const plantingFilterFields = {
  ...auditDateFilterFields,
  ...generatedPlantingFilterFields,
  locationId: oneOrMany(locationShortcode).optional(),
  ingredientId: oneOrMany(ingredientShortcode).optional(),
  taskId: oneOrMany(taskShortcode).optional(),
  sourceProductId: oneOrMany(productShortcode).optional(),
  activeOn: plainDate.optional(),
};
export const plantingFiltersSchema = z.object(plantingFilterFields);
export type PlantingFilters = z.infer<typeof plantingFiltersSchema>;
export const plantingOut = z.object(generatedPlantingFieldSchemas.read);
export type PlantingOut = z.infer<typeof plantingOut>;
/** List-row projection: `plantingOut` plus the server-resolved gallery cover(s). */
export const plantingListItemOut = plantingOut.extend({
  displayImages: displayImagesField,
});
export const plantingListOut =
  createPaginatedResponseSchema(plantingListItemOut);
