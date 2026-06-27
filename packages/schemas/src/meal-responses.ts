import { z } from "zod";
import { ingredientAvailabilityStatus } from "./availability";
import { dbTimestampsOut } from "./common";
import { ingredientId, mealId, mealRecipeId, recipeId } from "./identifiers";
import { mealDate, mealDateRange, mealScale } from "./meal-shared";
import {
  costCalorieTotals,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

/** Cost/calorie totals scaled by a meal-recipe's multiplier. */
export const scaledTotals = costCalorieTotals;
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
    /** recipe.totals x scale, or null when totals are absent/stale. */
    scaledTotals: scaledTotals.nullable(),
  })
  .extend(dbTimestampsOut.shape);
export type MealRecipeOut = z.infer<typeof mealRecipeOut>;

/** Roll-up across a meal's recipes. `pending` means at least one recipe lacked totals. */
export const mealTotals = costCalorieTotals.extend({ pending: z.boolean() });
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

export const mealListOut = z.array(mealOut);

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
  /** max(0, need - have). */
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
