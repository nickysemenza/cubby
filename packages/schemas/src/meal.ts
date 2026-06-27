import { z } from "zod";
import { mealId, mealRecipeId, recipeId } from "./identifiers";
import { mealDate, mealScale } from "./meal-shared";

export { mealDate, mealDateRange, mealScale } from "./meal-shared";

/**
 * Meal-planning schemas. A `meal` is a planned eating occasion on a calendar day
 * that groups one or more recipes (`mealRecipe`), each at a numeric `scale`
 * multiplier. Cost/calorie rollups are derived read-time from `recipe.totals ×
 * scale` (totals are linear in scale) — nothing is denormalized onto the tables.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A recipe to plan into a meal. */
export const mealRecipeInput = z.object({
  recipeId: recipeId.describe("Recipe ID to plan into the meal"),
  scale: mealScale.default(1).describe("Scale multiplier (1 = as written)"),
  sortOrder: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sort order within the meal"),
});
export type MealRecipeInput = z.infer<typeof mealRecipeInput>;

export const mealCreateInput = z.object({
  date: mealDate,
  name: z.string().nullable().optional(),
  sortOrder: z.number().int().nullable().optional(),
  // Optional: create a meal with its recipes in one call.
  recipes: z.array(mealRecipeInput).optional(),
});
export type MealCreateInput = z.infer<typeof mealCreateInput>;

/** Mutable meal fields (recipes are managed via addRecipe/updateRecipe/removeRecipe). */
export const mealUpdateData = z.object({
  date: mealDate.optional(),
  name: z.string().nullable().optional(),
  sortOrder: z.number().int().nullable().optional(),
});
export const mealUpdateInput = z.object({
  id: mealId,
  data: mealUpdateData,
});
export type MealUpdateInput = z.infer<typeof mealUpdateInput>;

export const mealAddRecipeInput = z.object({
  mealId,
  recipeId: recipeId.describe("Recipe ID to plan into the meal"),
  scale: mealScale.default(1).describe("Scale multiplier (1 = as written)"),
  sortOrder: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sort order within the meal"),
});

export const mealUpdateRecipeInput = z.object({
  id: mealRecipeId,
  scale: mealScale.optional(),
  sortOrder: z.number().int().nullable().optional(),
});

export const mealRecipeIdInput = z.object({
  id: mealRecipeId,
});

export const mealFiltersSchema = z.object({
  from: mealDate.optional(),
  to: mealDate.optional(),
});
export type MealFilters = z.infer<typeof mealFiltersSchema>;
