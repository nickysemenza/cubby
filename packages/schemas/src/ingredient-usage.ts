import { z } from "zod";
import { ingredientShortcode } from "./identifiers";

// How many distinct recipes use each (real) ingredient, optionally scoped to a
// cookbook. Sub-recipe pointers (ingredient.recipeId set) are excluded upstream.
const ingredientUsageRowSchema = z.object({
  ingredientId: ingredientShortcode,
  name: z.string(),
  recipeCount: z.number(),
  // Whole-number percent of the scope's recipes using it, rounded once on the
  // server so every client prints the same figure (`recipeSharePercent`).
  sharePercent: z.number(),
});

export const recipeSharePercent = (
  recipeCount: number,
  totalRecipes: number,
): number =>
  totalRecipes > 0 ? Math.round((recipeCount / totalRecipes) * 100) : 0;

export const ingredientUsageSchema = z.object({
  rows: z.array(ingredientUsageRowSchema),
  // Total recipes in scope — denominator for the "% of recipes" column.
  totalRecipes: z.number(),
});

export type IngredientUsageRow = z.infer<typeof ingredientUsageRowSchema>;
export type IngredientUsage = z.infer<typeof ingredientUsageSchema>;
