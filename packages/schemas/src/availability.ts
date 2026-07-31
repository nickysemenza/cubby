import { z } from "zod";
import { amount } from "./codec";
import {
  ingredientId,
  ingredientShortcode,
  recipeId,
  recipeShortcode,
} from "./identifiers";

export const ingredientAvailabilityStatus = z.enum([
  "ok",
  "short",
  "missing",
  "unconvertible",
  "subrecipe",
]);
export type IngredientAvailabilityStatus = z.infer<
  typeof ingredientAvailabilityStatus
>;

export const ingredientAvailabilityOut = z.object({
  ingredientId: ingredientId.nullable(),
  shortcode: ingredientShortcode.nullable(),
  name: z.string(),
  need: amount.nullable(),
  basisUnit: z.string().nullable(),
  needValue: z.number().nullable(),
  haveValue: z.number().nullable(),
  status: ingredientAvailabilityStatus,
});
export type IngredientAvailability = z.infer<typeof ingredientAvailabilityOut>;

export const aggregatedNeedOut = z.object({
  ingredientId: ingredientId.nullable(),
  ingredientShortcode: ingredientShortcode.nullable(),
  name: z.string(),
  basisUnit: z.string().nullable(),
  needValue: z.number(),
  haveValue: z.number().nullable(),
  status: ingredientAvailabilityStatus,
  sources: z.array(
    z.object({ lineIndex: z.number().int(), needValue: z.number() }),
  ),
});
export type AggregatedNeed = z.infer<typeof aggregatedNeedOut>;

export const recipeAvailabilityOut = z.object({
  recipeId,
  recipeShortcode,
  recipeName: z.string(),
  coverage: z.number(),
  totalIngredients: z.number().int(),
  availableIngredients: z.number().int(),
  ingredients: z.array(ingredientAvailabilityOut),
  missing: z.array(z.string()),
});
export type RecipeAvailability = z.infer<typeof recipeAvailabilityOut>;

export const recipeAvailabilityListOut = z.array(recipeAvailabilityOut);
