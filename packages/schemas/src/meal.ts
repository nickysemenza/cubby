import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { mealRelatedFilterFields } from "./related-view";
import { ingredientAvailabilityStatus } from "./availability";
import {
  ingredientShortcode,
  mealRecipeId,
  mealShortcode,
  recipeShortcode,
} from "./identifiers";
import { mealDate, mealScale } from "./meal-shared";
import { createPaginatedResponseSchema } from "./pagination";
import {
  costCalorieTotals,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

export { mealDate, mealDateRange, mealScale } from "./meal-shared";

export const mealSortableFields = ["date", "createdAt", "updatedAt"] as const;

export type MealSortField = (typeof mealSortableFields)[number];

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
  recipeId: recipeShortcode.describe("Recipe ID to plan into the meal"),
  scale: mealScale.default(1).describe("Scale multiplier (1 = as written)"),
  sortOrder: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sort order within the meal"),
});
export type MealRecipeInput = z.infer<typeof mealRecipeInput>;

const mealCreateShape = {
  date: mealDate,
  name: z.string().nullable().optional(),
  sortOrder: z.number().int().nullable().optional(),
  // Optional: create a meal with its recipes in one call.
  recipes: z.array(mealRecipeInput).optional(),
};
export const mealCreateInput = z.object(mealCreateShape);
export type MealCreateInput = z.infer<typeof mealCreateInput>;

/** Mutable meal fields (recipes are managed via addRecipe/updateRecipe/removeRecipe). */
export const mealUpdateData = deriveUpdateData(mealCreateShape, {
  omit: ["recipes"],
});
export const mealUpdateInput = z.object({
  id: mealShortcode,
  data: mealUpdateData,
});
export type MealUpdateInput = z.infer<typeof mealUpdateInput>;

export const mealAddRecipeInput = z.object({
  mealId: mealShortcode,
  recipeId: recipeShortcode.describe("Recipe ID to plan into the meal"),
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

export const mealFilterFields = {
  ...auditDateFilterFields,
  from: mealDate.optional().describe("Only meals on or after this day"),
  to: mealDate.optional().describe("Only meals on or before this day"),
  ...mealRelatedFilterFields,
};

export const mealFiltersSchema = z.object(mealFilterFields);
export type MealFilters = z.infer<typeof mealFiltersSchema>;

/** Cost/calorie totals scaled by a meal-recipe's multiplier. */
export const scaledTotals = costCalorieTotals;
export type ScaledTotals = z.infer<typeof scaledTotals>;

/** A recipe as summarized inside a meal (no ingredient graph). */
export const mealRecipeSummary = z.object({
  id: recipeShortcode,
  name: z.string(),
  servings: z.number().nullish(),
  yield: recipeYieldSchema.nullish(),
  totals: recipeTotals.nullish(),
});

export const mealRecipeOut = z.object({
  id: mealRecipeId,
  mealId: mealShortcode,
  recipeId: recipeShortcode,
  recipe: mealRecipeSummary,
  scale: mealScale,
  sortOrder: z.number().int().nullable(),
  /** recipe.totals x scale, or null when totals are absent/stale. */
  scaledTotals: scaledTotals.nullable(),
  ...timestampedFields,
});
export type MealRecipeOut = z.infer<typeof mealRecipeOut>;

/** Roll-up across a meal's recipes. `pending` means at least one recipe lacked totals. */
export const mealTotals = z.object({
  costTotal: z.number(),
  costTotalUpper: z.number().optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
  pending: z.boolean(),
});
export type MealTotals = z.infer<typeof mealTotals>;

export const mealOut = z.object({
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  recipes: z.array(mealRecipeOut),
  totals: mealTotals,
  ...timestampedFields,
});
export type MealOut = z.infer<typeof mealOut>;

const mealMcpRecipeFields = {
  // mealRecipe row id — declared exception, no shortcode; stays uuid.
  id: mealRecipeId,
  recipeId: recipeShortcode,
  name: z.string().nullable(),
  scale: mealScale,
  scaledTotals: scaledTotals.nullable(),
};

/** Slim MCP projection of a meal row. */
export const mealMcpOut = z.object({
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  totals: mealTotals,
  recipes: z.array(z.object(mealMcpRecipeFields)),
});
export type MealMcpOut = z.infer<typeof mealMcpOut>;

export const mealMcpListOut = createPaginatedResponseSchema(mealMcpOut);

export const mealListOut = z.array(mealOut);

/** Which meal/recipe contributed how much of an item's total need. */
export const shoppingListContribution = z.object({
  mealId: mealShortcode,
  mealName: z.string().nullable(),
  date: mealDate,
  recipeId: recipeShortcode,
  recipeName: z.string(),
  scale: mealScale,
  /** This contribution's need, in the item's `basisUnit`. */
  needValue: z.number(),
});
export type ShoppingListContribution = z.infer<typeof shoppingListContribution>;

export const shoppingListItem = z.object({
  ingredientId: ingredientShortcode.nullable(),
  name: z.string(),
  /** Unit `needValue`/`haveValue` are expressed in: grams when convertible, else the need's own unit. */
  basisUnit: z.string().nullable(),
  /** Total need across all meals in range (sum of scaled needs). */
  needValue: z.number(),
  /** On-hand inventory, counted once for the ingredient; null if unconvertible. */
  haveValue: z.number().nullable(),
  /** max(0, need - have). */
  shortfall: z.number(),
  status: ingredientAvailabilityStatus,
  perMeal: z.array(shoppingListContribution),
});
export type ShoppingListItem = z.infer<typeof shoppingListItem>;

export const shoppingListOut = z.object({
  from: mealDate,
  to: mealDate,
  meals: z.array(
    z.object({
      id: mealShortcode,
      name: z.string().nullable(),
      date: mealDate,
    }),
  ),
  items: z.array(shoppingListItem),
});
export type ShoppingListOut = z.infer<typeof shoppingListOut>;
