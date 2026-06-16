import { z } from "zod";
import { ingredientAvailabilityStatus } from "./availability";
import { dbTimestampsOut } from "./common";
import { ingredientId, mealId, mealRecipeId, recipeId } from "./identifiers";
import { recipeTotals, recipeYieldSchema } from "./recipe";

/**
 * Meal-planning schemas. A `meal` is a planned eating occasion on a calendar day
 * that groups one or more recipes (`mealRecipe`), each at a numeric `scale`
 * multiplier. Cost/calorie rollups are derived read-time from `recipe.totals ×
 * scale` (totals are linear in scale) — nothing is denormalized onto the tables.
 */

/** Scale multiplier for a planned recipe (e.g. 1.5×). */
export const mealScale = z.number().min(0.01).max(1000);

/** A calendar day as a plain "YYYY-MM-DD" string — timezone-free (see schema.ts). */
export const mealDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe('Calendar day as "YYYY-MM-DD"');

/** An inclusive [from, to] calendar-day range (both required). */
export const mealDateRange = z.object({ from: mealDate, to: mealDate });

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

export const mealFiltersSchema = z.object({
  from: mealDate.optional(),
  to: mealDate.optional(),
});
export type MealFilters = z.infer<typeof mealFiltersSchema>;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Cost/calorie totals scaled by a meal-recipe's multiplier, or null if the
 * recipe's totals haven't been computed yet (don't show 0 — show pending). */
export const scaledTotals = z.object({
  costTotal: z.number(),
  costTotalUpper: z.number().optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
});
export type ScaledTotals = z.infer<typeof scaledTotals>;

/** A recipe as summarized inside a meal (no ingredient graph). */
export const mealRecipeSummary = z.object({
  id: recipeId,
  name: z.string(),
  servings: z.number().nullish(),
  yield: recipeYieldSchema.nullish(),
  totals: recipeTotals.nullish(),
});

export const mealRecipeOut = z
  .object({
    id: mealRecipeId,
    mealId,
    recipeId,
    recipe: mealRecipeSummary,
    scale: mealScale,
    sortOrder: z.number().int().nullable(),
    /** recipe.totals × scale, or null when totals are absent/stale. */
    scaledTotals: scaledTotals.nullable(),
  })
  .extend(dbTimestampsOut.shape);
export type MealRecipeOut = z.infer<typeof mealRecipeOut>;

/** Roll-up across a meal's recipes. `pending` ⇒ at least one recipe lacked totals. */
export const mealTotals = z.object({
  costTotal: z.number(),
  costTotalUpper: z.number().optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
  pending: z.boolean(),
});
export type MealTotals = z.infer<typeof mealTotals>;

export const mealOut = z
  .object({
    id: mealId,
    date: mealDate,
    name: z.string().nullable(),
    sortOrder: z.number().int().nullable(),
    recipes: z.array(mealRecipeOut),
    totals: mealTotals,
  })
  .extend(dbTimestampsOut.shape);
export type MealOut = z.infer<typeof mealOut>;

// ---------------------------------------------------------------------------
// Shopping list (display-only)
// ---------------------------------------------------------------------------

/** Which meal/recipe contributed how much of an item's total need. */
export const shoppingListContribution = z.object({
  mealId,
  mealName: z.string().nullable(),
  date: mealDate,
  recipeId,
  recipeName: z.string(),
  scale: mealScale,
  /** This contribution's need, in the item's `basisUnit`. */
  needValue: z.number(),
});
export type ShoppingListContribution = z.infer<typeof shoppingListContribution>;

export const shoppingListItem = z.object({
  ingredientId: ingredientId.nullable(),
  name: z.string(),
  /** Unit `needValue`/`haveValue` are expressed in: grams when convertible, else the need's own unit. */
  basisUnit: z.string().nullable(),
  /** Total need across all meals in range (sum of scaled needs). */
  needValue: z.number(),
  /** On-hand inventory, counted once for the ingredient; null if unconvertible. */
  haveValue: z.number().nullable(),
  /** max(0, need − have). */
  shortfall: z.number(),
  status: ingredientAvailabilityStatus,
  perMeal: z.array(shoppingListContribution),
});
export type ShoppingListItem = z.infer<typeof shoppingListItem>;

export const shoppingListOut = mealDateRange.extend({
  meals: z.array(
    z.object({ id: mealId, name: z.string().nullable(), date: mealDate }),
  ),
  items: z.array(shoppingListItem),
});
export type ShoppingListOut = z.infer<typeof shoppingListOut>;
