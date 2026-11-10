import {
  ingredientOut,
  ingredientDetailOut as ingredientWithFoodOut,
  ingredientFilterFields as ingredientBaseFilterFields,
} from "@cubby/schemas/entities/ingredient";
import { withFieldEnvelopes } from "./field-envelope";
import {
  ingredientFieldEnvelopeFields,
  ingredientPublicReadFields,
} from "./generated/entity-field-envelope-fields.ingredient.gen";
import { rawIngredientEnrichment } from "./ingredient-raw-read";

import { z } from "zod";
import { ingredientShortcode, recipeShortcode } from "./identifiers";
import { presenceFilter } from "./pagination";
import { recipeUsageOut } from "./recipe-fields";

export const ingredientFilterFields = {
  ...ingredientBaseFilterFields,
  productPresenceFilter: presenceFilter,
  /**
   * `"none"` is the orphaned-ingredient worklist. The list already excludes
   * recipe-as-ingredient pointer rows (`ingredient.recipeId IS NULL`), so a
   * `"none"` hit really is an ingredient no live recipe references.
   */
  /**
   * Like {@link recipePresenceFilter}, but counting only NON-COOKBOOK recipes.
   *
   * `"has"` plus `productPresenceFilter: "none"` is the costing worklist: an
   * ingredient one of your own recipes needs, with no product to price it from.
   * The distinction is the whole point — on this database the cookbook import
   * supplies the overwhelming majority of ingredient usages, and folding them
   * in turns 24 actionable rows into ~1000.
   */
  ownRecipePresenceFilter: presenceFilter.describe(
    "Filter to ingredients that are / aren't used by at least one live recipe of your own (excludes cookbook imports).",
  ),
  recipePresenceFilter: presenceFilter.describe(
    "Filter to ingredients that are / aren't used by at least one live recipe",
  ),
  mappingGap: z
    .boolean()
    .optional()
    .describe(
      "true: ingredients used by at least one live recipe with no live linked product whose conversion coverage is complete (the product-mapping worklist); false: every other ingredient.",
    ),
};

export const ingredientFiltersSchema = z.object(ingredientFilterFields);
export type IngredientFilters = z.infer<typeof ingredientFiltersSchema>;

/**
 * Per-cluster change summary returned by an ingredient merge — the serialized
 * shape surfaced to the MCP tool / any caller. The repo's internal `MergeSummary`
 * extends this with the (never-serialized) `affectedRecipeIds` it dispatches.
 */
export const mergeSummary = z.object({
  /** Names newly added to the target's `aliases` (excludes pre-existing). */
  aliasesAdded: z.array(z.string()),
  recipesMoved: z.number().int().nonnegative(),
  /** Product rows re-pointed onto the target (incl. soft-deleted). */
  productsMoved: z.number().int().nonnegative(),
  deletedIds: z.array(ingredientShortcode),
  /**
   * Ingredient rows the merge actually hard-deleted, read back from the DELETE
   * itself (`finalizeMerge`) rather than assumed from `mergeIds.length`.
   */
  merged: z.number().int().nonnegative(),
});
export type MergeSummaryOut = z.infer<typeof mergeSummary>;

export const ingredientRecipeUsagesOut = z.array(recipeUsageOut);

const ingredientMatchOut = z
  .object({
    id: ingredientShortcode,
    name: z.string(),
    aliases: z.array(z.string()),
  })
  .nullable();

export const ingredientMatchesOut = z.record(z.string(), ingredientMatchOut);

export const ingredientResolveOrCreateResultOut = z.object({
  name: z.string(),
  id: ingredientShortcode,
  /**
   * The resolved ingredient's own name and aliases. Both differ from the
   * requested `name` whenever the match came through a casing variant or an
   * alias, so a caller that displays or re-parses the result reads these rather
   * than echoing back what it asked for.
   */
  canonicalName: z.string(),
  aliases: z.array(z.string()),
  matched: z.boolean(),
  created: z.boolean(),
});

export const ingredientResolveOrCreateOut = z.array(
  ingredientResolveOrCreateResultOut,
);

/**
 * The one linked product that supplies an ingredient's nutrition, chosen once on
 * the server so web and native show the same product: the one carrying both
 * nutrition and a price (nutrition and cost-per-nutrient must share a basis),
 * a package label before USDA. `display` is that product's `nutritionDisplay`.
 */
export { type IngredientNutritionProductOut } from "./ingredient-read-fields";

/** Generic MCP entity detail with storage-only child identifiers removed. */

export const ingredientWithFoodLeanOut = ingredientOut.extend({
  product: ingredientWithFoodOut.shape.product,
});
export type IngredientWithFoodLeanOut = z.output<
  typeof ingredientWithFoodLeanOut
>;

// The ingredient list row: lean ingredient + DB-only products, plus {id,name}
// refs of recipes it appears in. USDA summaries hydrate separately.

/** Generic MCP entity list row with storage-only product child ids removed. */

export const enrichmentRowOut = withFieldEnvelopes(
  rawIngredientEnrichment,
  ingredientFieldEnvelopeFields,
  ingredientPublicReadFields,
).extend({
  product: ingredientWithFoodOut.shape.product,
});

export const enrichmentWorkbenchInput = z
  .object({
    recipeId: recipeShortcode.optional(),
    focusId: ingredientShortcode.optional(),
  })
  .optional();

export const ingredientMergeInput = z.object({
  keepId: ingredientShortcode,
  mergeIds: z.array(ingredientShortcode).min(1),
});

export const ingredientIdInput = z.object({
  id: ingredientShortcode,
});

export const ingredientIdsInput = z.object({
  ids: z.array(ingredientShortcode),
});

export const ingredientNameFilterInput = z.object({
  nameFilter: z.string(),
});

export const ingredientNamesInput = z.object({
  names: z.array(z.string()),
});

export const ingredientResolvableNamesInput = z.object({
  names: z.array(z.string().min(1)).max(1000),
});
