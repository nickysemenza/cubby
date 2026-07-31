import { z } from "zod";
import { recipeAvailabilityListOut } from "./availability";
import { recipeShortcode } from "./identifiers";

export const recipeAvailabilityInput = z.object({
  recipeId: recipeShortcode,
});

export const makeableRecipesInput = z.object({
  minCoverage: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

// Ranking scores a bounded candidate pool, so the answer can be partial:
// `truncated` says the pool hit that cap and recipes beyond it were never
// scored — the UI has to admit that rather than imply a complete answer.
export const makeableRecipesOut = z.object({
  recipes: recipeAvailabilityListOut,
  truncated: z.boolean(),
  candidateCap: z.number().int().positive(),
});

export type RecipeAvailabilityInput = z.infer<typeof recipeAvailabilityInput>;
export type MakeableRecipesInput = z.infer<typeof makeableRecipesInput>;
