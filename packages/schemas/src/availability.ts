import { z } from "zod";
import { amount } from "./codec";
import { ingredientId, recipeId } from "./identifiers";

/**
 * Output schemas for the recipe-availability engine
 * (apps/web/.../services/availability.service.ts). Single source of truth for the
 * service's return type and the tRPC `suggestions` router's `.output(...)`.
 */

export const ingredientAvailabilityStatus = z.enum([
  "ok", // enough on hand
  "short", // some on hand, but not enough
  "missing", // none on hand
  "unconvertible", // on hand, but its unit can't be reconciled with the need
  "subrecipe", // the ingredient is itself a recipe (not resolved in v1)
]);
export type IngredientAvailabilityStatus = z.infer<
  typeof ingredientAvailabilityStatus
>;

export const ingredientAvailabilityOut = z.object({
  ingredientId: ingredientId.nullable(),
  name: z.string(),
  /** What the recipe needs (first amount), as authored — for display. */
  need: amount.nullable(),
  /** Unit `needValue`/`haveValue` are compared in: grams when available, else the recipe's own unit. */
  basisUnit: z.string().nullable(),
  /** `need` expressed in `basisUnit`. */
  needValue: z.number().nullable(),
  /** Total on hand expressed in `basisUnit`; null if it couldn't be measured. */
  haveValue: z.number().nullable(),
  status: ingredientAvailabilityStatus,
});
export type IngredientAvailability = z.infer<typeof ingredientAvailabilityOut>;

export const recipeAvailabilityOut = z.object({
  recipeId,
  recipeName: z.string(),
  /** Fraction of resolvable ingredients fully covered (0..1). */
  coverage: z.number(),
  /** Count of resolvable (non-subrecipe) ingredients. */
  totalIngredients: z.number().int(),
  /** Count with status "ok". */
  availableIngredients: z.number().int(),
  ingredients: z.array(ingredientAvailabilityOut),
  /** Names of resolvable ingredients that are not fully covered. */
  missing: z.array(z.string()),
});
export type RecipeAvailability = z.infer<typeof recipeAvailabilityOut>;
