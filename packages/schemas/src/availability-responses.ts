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

/**
 * One ingredient's aggregated need across many planned recipes (the shopping-list
 * engine, AvailabilityService.getAggregatedNeeds). `needValue` sums the scaled
 * needs of every contributing line; `haveValue` is the on-hand total counted
 * ONCE for the ingredient (never per-line — that would multiply inventory).
 * `sources[].lineIndex` indexes back into the `lines` array the caller passed,
 * so the caller can attribute each contribution to its meal/recipe.
 */
export const aggregatedNeedOut = z.object({
  ingredientId: ingredientId.nullable(),
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

export const recipeAvailabilityListOut = z.array(recipeAvailabilityOut);
