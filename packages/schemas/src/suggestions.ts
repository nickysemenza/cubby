import { z } from "zod";
import { recipeAvailabilityListOut } from "./availability";
import { recipeShortcode } from "./identifiers";

export const recipeAvailabilityInput = z.object({
  recipeId: recipeShortcode,
});

export const makeableRecipesInput = z.object({
  minCoverage: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Only return recipes with at least this coverage (0..1)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(24)
    .describe("Max recipes to return"),
});

// Ranking scores a bounded candidate pool, so the answer can be partial:
// `truncated` says the pool hit that cap and recipes beyond it were never
// scored — the UI has to admit that rather than imply a complete answer.
export const makeableRecipesOut = z.object({
  recipes: recipeAvailabilityListOut,
  truncated: z.boolean(),
  candidateCap: z.number().int().positive(),
});
