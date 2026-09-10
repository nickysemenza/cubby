import { z } from "zod";
import { timestampedFields } from "./base-entity";
import { money } from "./money";
import { mealRecipeId, mealShortcode, recipeShortcode } from "./identifiers";
import { mealScale, mealYieldGrams } from "./meal-shared";
import {
  costCalorieTotals,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

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
  estimatedYieldGrams: mealYieldGrams.nullable(),
  actualYieldGrams: mealYieldGrams.nullable(),
  /** recipe.totals x scale, or null when totals are absent/stale. */
  scaledTotals: scaledTotals.nullable(),
  ...timestampedFields,
});
export type MealRecipeOut = z.infer<typeof mealRecipeOut>;

export const mealTotals = z.object({
  costTotal: money,
  costTotalUpper: money.optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
  pending: z.boolean(),
});
export type MealTotals = z.infer<typeof mealTotals>;
