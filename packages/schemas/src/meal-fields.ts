import { z } from "zod";
import { timestampedFields } from "./base-entity";
import { storedProjectionVersionsSchema } from "./field-envelope";
import {
  mealRecipeId,
  mealShortcode,
  recipeShortcode,
} from "./identifier-fields";
import { mealScale, mealYieldGrams } from "./meal-shared";
import { nutritionTotals } from "./nutrition";
import { rawRecipeTopLevel, recipeTotals } from "./recipe-shared";

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

export const scaledTotals = nutritionTotals;
export type ScaledTotals = z.infer<typeof scaledTotals>;

/** A recipe as summarized inside a meal (no ingredient graph). */
export const rawMealRecipeSummary = rawRecipeTopLevel
  .pick({
    id: true,
    name: true,
    servings: true,
    yield: true,
  })
  .extend({
    totals: recipeTotals.nullish(),
    storedProjectionVersions: storedProjectionVersionsSchema,
  });

export const rawMealRecipeOut = z.object({
  id: mealRecipeId,
  mealId: mealShortcode,
  recipeId: recipeShortcode,
  recipe: rawMealRecipeSummary,
  scale: mealScale,
  sortOrder: z.number().int().nullable(),
  estimatedYieldGrams: mealYieldGrams.nullable(),
  actualYieldGrams: mealYieldGrams.nullable(),
  /** Current recipe totals scaled to this occurrence. */
  scaledTotals,
  ...timestampedFields,
});
export type RawMealRecipeOut = z.infer<typeof rawMealRecipeOut>;

export const mealTotals = nutritionTotals;
export type MealTotals = z.infer<typeof mealTotals>;

import { displayImagesField } from "./display-images";
import { listLabel } from "./entity-definitions/label-field";
export function mealReadSchemas<S extends z.ZodRawShape>(base: z.ZodObject<S>) {
  const list = base.extend({
    displayImages: displayImagesField,
    // Server-composed text for the Cost column.
    costTotalLabel: listLabel,
  });
  return { output: base, list, detail: base };
}
