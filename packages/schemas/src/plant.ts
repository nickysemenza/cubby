import { z } from "zod";

import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { ingredientShortcode, plantShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import { gardenCropKey } from "./garden-practice";
import { plantBaseFilterFields, plantOut } from "./generated/plant.gen";

export {
  plantCreateInput,
  plantUpdateData,
  plantOut,
  type PlantCreateInput,
  type PlantUpdateData,
  type PlantOut,
} from "./generated/plant.gen";

export const plantFilterFields = {
  ...plantBaseFilterFields,
  ingredientId: oneOrMany(ingredientShortcode).optional(),
};
export const plantFiltersSchema = z.object(plantFilterFields);
export type PlantFilters = z.infer<typeof plantFiltersSchema>;

export type PlantSortField = GeneratedEntitySortField<"plant">;

export const plantListResponse = createPaginatedResponseSchema(plantOut);

/** `resolve_plants`: a cultivar or species name, optionally scoped to a crop. */
export const resolvePlantsInput = z.object({
  plants: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        gardenGuideKey: gardenCropKey.optional(),
        ingredientName: z.string().trim().min(1).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type ResolvePlantsInput = z.infer<typeof resolvePlantsInput>;

export const resolvePlantsOutput = z.object({
  plants: z.array(
    z.object({
      name: z.string(),
      id: plantShortcode,
      created: z.boolean(),
    }),
  ),
});
export type ResolvePlantsOutput = z.infer<typeof resolvePlantsOutput>;
