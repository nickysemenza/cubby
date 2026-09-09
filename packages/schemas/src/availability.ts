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

/** Whether planning coverage comes from counted stock or a staple assumption. */
export const availabilitySource = z.enum(["inventory", "assumed"]);
export type AvailabilitySource = z.infer<typeof availabilitySource>;

/** Incomplete authored recipe information that must remain visible. */
export const quantityIssue = z.enum(["missingAmount", "incompatibleNeedUnits"]);
export type QuantityIssue = z.infer<typeof quantityIssue>;

/** Why a sub-recipe's ingredients are absent. Mirrors `WNeedsBlockReason`. */
export const subRecipeBlockReason = z.enum([
  "cycle",
  "missingYield",
  "unknownRecipe",
  "unscalable",
  "noAmount",
]);
export type SubRecipeBlockReason = z.infer<typeof subRecipeBlockReason>;

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
  usuallyOnHand: z.boolean(),
  covered: z.boolean(),
  availabilitySource: availabilitySource.nullable(),
  quantityIssues: z.array(quantityIssue),
  via: z.array(needViaOut),
  /** Set only on `subrecipe` rows — why the expansion failed. */
  blockedReason: subRecipeBlockReason.nullable(),
});
export type IngredientAvailability = z.infer<typeof ingredientAvailabilityOut>;

export const aggregatedNeedOut = z.object({
  ingredientId: ingredientShortcode.nullable(),
  name: z.string(),
  basisUnit: z.string().nullable(),
  needValue: z.number().nullable(),
  haveValue: z.number().nullable(),
  status: ingredientAvailabilityStatus,
  usuallyOnHand: z.boolean(),
  covered: z.boolean(),
  availabilitySource: availabilitySource.nullable(),
  quantityIssues: z.array(quantityIssue),
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
      /** Null for amount-less or incompatible-unit recipe contributions. */
      needValue: z.number().nullable(),
      /** The authored quantity, retained even when it cannot be summed. */
      amount: amount.nullable(),
      via: z.array(needViaOut),
    }),
  ),
});
export type AggregatedNeed = z.infer<typeof aggregatedNeedOut>;

export const blockedSubRecipeOut = z.object({
  recipeId: recipeShortcode,
  name: z.string(),
  reason: subRecipeBlockReason,
  amount: amount.nullable(),
  via: z.array(needViaOut),
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
