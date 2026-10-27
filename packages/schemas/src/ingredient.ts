import { withFieldEnvelopes } from "./field-envelope";
import {
  ingredientFieldEnvelopeFields,
  ingredientPublicReadFields,
} from "./generated/entity-field-envelope-fields.ingredient.gen";
import { rawIngredientEnrichment } from "./ingredient-raw-read";
import { ingredientFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.ingredient.gen";
import ingredientDefinition from "./entity-definitions/02-ingredient.entity";
import { z } from "zod";
import { productRefOut } from "./product-fields";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { ingredientShortcode, recipeShortcode } from "./identifiers";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import { recipeUsageOut } from "./recipe-fields";
import { ingredientBaseFilterFields } from "./generated/ingredient.gen";

export {
  ingredientCreateInput,
  ingredientUpdateData,
  ingredientUpdateInput,
  type IngredientCreateInput,
  type IngredientUpdateInput,
} from "./generated/ingredient.gen";

export const ingredientBaseFields = {
  name: ingredientDefinition.readSchemas.output.shape.name,
  aliases: ingredientDefinition.readSchemas.output.shape.aliases,
};

export const ingredientBase = z.object(ingredientBaseFields);

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

export type IngredientSortField = GeneratedEntitySortField<"ingredient">;

const ingredientOutFields = ingredientDefinition.readSchemas.output.shape;

export const ingredientOut = ingredientFieldEnvelopeSchemas.output;
export type IngredientOut = z.infer<typeof ingredientOut>;

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

export const ingredientMatchOut = z
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
export {
  ingredientNutritionProductOut,
  type IngredientNutritionProductOut,
} from "./ingredient-read-fields";
export const ingredientWithFoodOut = ingredientFieldEnvelopeSchemas.detail;
export type IngredientWithFoodOut = z.infer<typeof ingredientWithFoodOut>;

/** Generic MCP entity detail with storage-only child identifiers removed. */
export const ingredientWithFoodMcpEntityOut =
  ingredientFieldEnvelopeSchemas.mcpDetail;

export const ingredientWithFoodLeanOut = ingredientOut.extend({
  product: ingredientWithFoodOut.shape.product,
});
export type IngredientWithFoodLeanOut = z.output<
  typeof ingredientWithFoodLeanOut
>;

// The ingredient list row: lean ingredient + DB-only products, plus {id,name}
// refs of recipes it appears in. USDA summaries hydrate separately.
export const ingredientListItemOut = ingredientFieldEnvelopeSchemas.list;
export type IngredientListItem = z.infer<typeof ingredientListItemOut>;

/** Generic MCP entity list row with storage-only product child ids removed. */
export const ingredientListItemMcpEntityOut =
  ingredientFieldEnvelopeSchemas.mcpList;

export { enrichmentFixKind } from "./ingredient-raw-read";
export const enrichmentRowOut = withFieldEnvelopes(
  rawIngredientEnrichment,
  ingredientFieldEnvelopeFields,
  ingredientPublicReadFields,
).extend({
  product: ingredientWithFoodOut.shape.product,
});
export type EnrichmentRow = z.output<typeof enrichmentRowOut>;

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

/**
 * Slim MCP projection of an ingredient list/detail row.
 *
 * The scalar half is built from the same field map as `ingredientOut`, so it
 * cannot drift from the plain shape. The two added keys are aggregates no
 * plain ingredient output carries under these names: `products` is a
 * `{id,name}` digest of `product[]`, and `recipeCount` counts
 * `appearsInRecipes[]` (the list row's `ownRecipeCount` counts something else
 * and the detail row has no count at all).
 */
export const ingredientMcpOut = z.object({
  id: ingredientOutFields.id,
  name: ingredientOutFields.name,
  aliases: ingredientOutFields.aliases,
  naKinds: ingredientOutFields.naKinds,
  usuallyOnHand: ingredientOutFields.usuallyOnHand,
  products: z.array(productRefOut),
  recipeCount: z.number().int().nonnegative(),
});
export type IngredientMcpOut = z.infer<typeof ingredientMcpOut>;

export const ingredientMcpListOut =
  createPaginatedResponseSchema(ingredientMcpOut);
