import { z } from "zod";

import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { plantShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { gardenCropKey } from "./garden-practice";
import {
  plantFilterFields as plantBaseFilterFields,
  plantOut,
} from "@cubby/schemas/entities/plant";

export const plantFilterFields = plantBaseFilterFields;
export const plantFiltersSchema = z.object(plantFilterFields);
export type PlantFilters = z.infer<typeof plantFiltersSchema>;

export type PlantSortField = GeneratedEntitySortField<"plant">;

export const plantListResponse = createPaginatedResponseSchema(plantOut);

/** `entity.resolve`: a cultivar or species name, optionally scoped to a crop. */
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
