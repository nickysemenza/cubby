import { z } from "zod";
import { auditDateFilterFields } from "./base-entity";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import {
  generatedIngredientFieldSchemas,
  generatedIngredientFilterFields,
} from "./generated/entity-field-schemas.ingredient.gen";
import {
  ingredientShortcode,
  productShortcode,
  recipeShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import {
  productWithMappingsAndFoodMcpEntityOut,
  productWithMappingsAndFoodOut,
  productWithMappingsMcpEntityOut,
  productWithMappingsOut,
} from "./product";
import { baseKind } from "./problems";
import {
  recipeRefOut,
  recipeTopLevel,
  recipeRefMcpEntityOut,
  recipeUsageRefMcpEntityOut,
  recipeUsageOut,
} from "./recipe";
import { mutationSideEffectsSchema } from "./background-jobs";
import { displayImagesField } from "./display-images";
import { ingredientRelatedFilterFields } from "./related-view";

export const ingredientBaseFields = {
  name: generatedIngredientFieldSchemas.read.name,
  aliases: generatedIngredientFieldSchemas.read.aliases,
};

export const ingredientBase = z.object(ingredientBaseFields);

export const ingredientFilterFields = {
  ...auditDateFilterFields,
  ...generatedIngredientFilterFields,
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
  ...ingredientRelatedFilterFields,
};

export const ingredientFiltersSchema = z.object(ingredientFilterFields);
export type IngredientFilters = z.infer<typeof ingredientFiltersSchema>;

export type IngredientSortField = GeneratedEntitySortField<"ingredient">;

export const ingredientOutFields = {
  ...generatedIngredientFieldSchemas.read,
};

export const ingredientOut = z.object(ingredientOutFields);
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

export const ingredientWithRecipesAndProductOut = z.object({
  ...ingredientOutFields,
  recipe: recipeTopLevel.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  appearsInRecipes: z.array(recipeTopLevel),
  product: z.array(productWithMappingsOut),
});
export type IngredientWithRecipesAndProductOut = z.infer<
  typeof ingredientWithRecipesAndProductOut
>;

export const ingredientWithFoodOut = z.object({
  ...ingredientOutFields,
  recipe: recipeTopLevel.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  appearsInRecipes: z.array(recipeTopLevel),
  product: z.array(productWithMappingsAndFoodOut),
});
export type IngredientWithFoodOut = z.infer<typeof ingredientWithFoodOut>;

/** Generic MCP entity detail with storage-only child identifiers removed. */
export const ingredientWithFoodMcpEntityOut = ingredientWithFoodOut.extend({
  recipe: recipeRefMcpEntityOut.nullable(),
  recipeUsages: z.array(recipeUsageRefMcpEntityOut),
  appearsInRecipes: z.array(recipeRefMcpEntityOut),
  product: z.array(productWithMappingsAndFoodMcpEntityOut),
});

export const ingredientWithFoodAndSideEffectsOut = z.object({
  ...ingredientOutFields,
  recipe: recipeTopLevel.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  appearsInRecipes: z.array(recipeTopLevel),
  product: z.array(productWithMappingsAndFoodOut),
  sideEffects: mutationSideEffectsSchema,
});
export type IngredientWithFoodAndSideEffectsOut = z.infer<
  typeof ingredientWithFoodAndSideEffectsOut
>;

export const ingredientMergeOut = z.object({
  ...ingredientOutFields,
  recipe: recipeTopLevel.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  appearsInRecipes: z.array(recipeTopLevel),
  product: z.array(productWithMappingsAndFoodOut),
  sideEffects: mutationSideEffectsSchema,
  mergeSummary,
});
export type IngredientMergeOut = z.infer<typeof ingredientMergeOut>;

export const ingredientWithFoodLeanOut = z.object({
  ...ingredientOutFields,
  product: z.array(productWithMappingsAndFoodOut),
});
export type IngredientWithFoodLeanOut = z.infer<
  typeof ingredientWithFoodLeanOut
>;

// The ingredient list row: lean ingredient + DB-only products, plus {id,name}
// refs of recipes it appears in. USDA summaries hydrate separately.
export const ingredientListItemOut = z.object({
  ...ingredientOutFields,
  displayImages: displayImagesField,
  product: z.array(productWithMappingsOut),
  appearsInRecipes: z.array(recipeRefOut),
  ownRecipeCount: z.number().int(),
});
export type IngredientListItem = z.infer<typeof ingredientListItemOut>;

/** Generic MCP entity list row with storage-only product child ids removed. */
export const ingredientListItemMcpEntityOut = ingredientListItemOut.extend({
  product: z.array(productWithMappingsMcpEntityOut),
});

export const enrichmentFixKind = z.enum([
  "no-product",
  "link-usda",
  "set-per-item-price",
  "add-purchase-mapping",
  "add-weight-mapping",
  "add-volume-mapping",
  "done",
]);

export const enrichmentRowOut = z.object({
  ...ingredientOutFields,
  product: z.array(productWithMappingsAndFoodOut),
  recipeCount: z.number().int().nonnegative(),
  cookbookOnly: z.boolean(),
  coverage: z.object({
    covered: z.array(baseKind),
    applicable: z.array(baseKind),
    tier: z.enum(["complete", "good", "partial", "none"]),
  }),
  recommendedFix: enrichmentFixKind,
  priceMode: z.enum(["per-each", "package"]),
  mergeCandidates: z.array(
    z.object({
      id: ingredientShortcode,
      name: z.string(),
      similarity: z.number(),
    }),
  ),
});
export type EnrichmentRow = z.infer<typeof enrichmentRowOut>;

export const enrichmentRowsOut = z.array(enrichmentRowOut);

export const enrichmentWorkbenchInput = z
  .object({
    recipeId: recipeShortcode.optional(),
    focusId: ingredientShortcode.optional(),
  })
  .optional();

export const ingredientWithFoodLeanListOut = z.array(ingredientWithFoodLeanOut);

/**
 * Input schema for creating ingredients. Overrides the base `name` (lax for
 * reads) with a non-empty constraint; keep the mock hint for test fixtures.
 */
const ingredientCreateFields = generatedIngredientFieldSchemas.create;
export const ingredientCreateInput = z.object(ingredientCreateFields);
export type IngredientCreateInput = z.infer<typeof ingredientCreateInput>;

export const ingredientUpdateData = z.object(
  generatedIngredientFieldSchemas.update,
);

export const ingredientUpdateInput = z.object({
  id: ingredientShortcode,
  data: ingredientUpdateData,
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;

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
  products: z.array(z.object({ id: productShortcode, name: z.string() })),
  recipeCount: z.number().int().nonnegative(),
});
export type IngredientMcpOut = z.infer<typeof ingredientMcpOut>;

export const ingredientMcpListOut =
  createPaginatedResponseSchema(ingredientMcpOut);
