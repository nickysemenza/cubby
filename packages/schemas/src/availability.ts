import { z } from "zod";
import { amount } from "./codec";
import { ingredientShortcode, recipeShortcode } from "./identifiers";
import { moneyNullable } from "./money";

export const ingredientAvailabilityStatus = z.enum([
  "ok",
  "short",
  "missing",
  "unconvertible",
  /**
   * A sub-recipe reference that could NOT be expanded — not "we don't do
   * sub-recipes". An expandable one contributes its ingredients as ordinary
   * rows and emits no placeholder. Excluded from coverage on purpose: you
   * can't score what you can't see.
   */
  "subrecipe",
]);
export type IngredientAvailabilityStatus = z.infer<
  typeof ingredientAvailabilityStatus
>;

/** Why a sub-recipe's ingredients are absent. Mirrors `WNeedsBlockReason`. */
export const subRecipeBlockReason = z.enum([
  "cycle",
  "missingYield",
  "unknownRecipe",
  "unscalable",
  "noAmount",
]);
export type SubRecipeBlockReason = z.infer<typeof subRecipeBlockReason>;

/** One hop of the sub-recipe chain a need was reached through, outermost first. */
export const needViaOut = z.object({
  recipeId: recipeShortcode,
  name: z.string(),
});
export type NeedVia = z.infer<typeof needViaOut>;

export const ingredientAvailabilityOut = z.object({
  ingredientId: ingredientShortcode.nullable(),
  name: z.string(),
  need: amount.nullable(),
  basisUnit: z.string().nullable(),
  needValue: z.number().nullable(),
  haveValue: z.number().nullable(),
  status: ingredientAvailabilityStatus,
  /** Empty for an ingredient written directly on the recipe. */
  via: z.array(needViaOut),
  /** Set only on `subrecipe` rows — why the expansion failed. */
  blockedReason: subRecipeBlockReason.nullable(),
});
export type IngredientAvailability = z.infer<typeof ingredientAvailabilityOut>;

export const aggregatedNeedOut = z.object({
  ingredientId: ingredientShortcode.nullable(),
  name: z.string(),
  basisUnit: z.string().nullable(),
  needValue: z.number(),
  haveValue: z.number().nullable(),
  status: ingredientAvailabilityStatus,
  /** `need - have`, floored at zero. Null when on-hand isn't known. */
  shortfall: z.number().nullable(),
  /**
   * What the shortfall would cost, in dollars.
   *
   * Null whenever the answer isn't known — no product, no price, or no unit
   * path from the ingredient's basis unit to money. Deliberately NOT zero: a
   * zero would sum into a trip total and quietly understate it, which is the
   * same lie `shortfall: null` exists to avoid.
   */
  estimatedCost: moneyNullable,
  sources: z.array(
    z.object({
      lineIndex: z.number().int(),
      needValue: z.number(),
      via: z.array(needViaOut),
    }),
  ),
});
export type AggregatedNeed = z.infer<typeof aggregatedNeedOut>;

/** A sub-recipe whose ingredients are absent from the needs it fed into. */
export const blockedSubRecipeOut = z.object({
  recipeId: recipeShortcode,
  name: z.string(),
  reason: subRecipeBlockReason,
  amount: amount.nullable(),
  via: z.array(needViaOut),
  /** Index into the caller's own line list. */
  lineIndex: z.number().int(),
});
export type BlockedSubRecipe = z.infer<typeof blockedSubRecipeOut>;

export const recipeAvailabilityOut = z.object({
  recipeId: recipeShortcode,
  recipeName: z.string(),
  coverage: z.number(),
  totalIngredients: z.number().int(),
  availableIngredients: z.number().int(),
  ingredients: z.array(ingredientAvailabilityOut),
  missing: z.array(z.string()),
  /** Omitted count: sub-recipe references excluded from `coverage`. */
  unexpandedSubRecipes: z.number().int(),
});
export type RecipeAvailability = z.infer<typeof recipeAvailabilityOut>;

export const recipeAvailabilityListOut = z.array(recipeAvailabilityOut);
