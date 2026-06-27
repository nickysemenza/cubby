import { z } from "zod";
import { recipeId } from "./identifiers";

export const recipeAvailabilityInput = z.object({
  recipeId,
});

export const makeableRecipesInput = z.object({
  minCoverage: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type RecipeAvailabilityInput = z.infer<typeof recipeAvailabilityInput>;
export type MakeableRecipesInput = z.infer<typeof makeableRecipesInput>;
