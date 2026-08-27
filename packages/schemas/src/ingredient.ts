import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { requiredName } from "./common";
import {
  ingredientShortcode,
  productShortcode,
  recipeShortcode,
} from "./identifiers";
import { firstDisplayableImage, type ImageOut } from "./image";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import {
  productWithMappingsAndFoodOut,
  productWithMappingsOut,
} from "./product";
import { baseKind } from "./problems";
import { recipeRefOut, recipeTopLevel, recipeUsageOut } from "./recipe";
import { mutationSideEffectsSchema } from "./background-jobs";

export const ingredientBaseFields = {
  // `mock` is a faker dot-path consumed by the test mock generator
  // (apps/web .../test/mock-schema.ts); it is plain metadata, faker-free here.
  name: z
    .string()
    .meta({ mock: "food.ingredient" })
    .describe("Ingredient name"),
  aliases: z.array(z.string()).describe("Alternate names for this ingredient"),
};

export const ingredientBase = z.object(ingredientBaseFields);

export const ingredientFilterFields = {
  ...auditDateFilterFields,
  nameFilter: z
    .string()
    .optional()
    .describe("Filter by ingredient name (substring)"),
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
};

export const ingredientFiltersSchema = z.object(ingredientFilterFields);
export type IngredientFilters = z.infer<typeof ingredientFiltersSchema>;

export const ingredientSortableFields = [
  "createdAt",
  "updatedAt",
  "name",
  "appearsInRecipes",
  "product",
] as const;

export type IngredientSortField = (typeof ingredientSortableFields)[number];

export const ingredientOutFields = {
  id: ingredientShortcode,
  ...ingredientBaseFields,
  // Base measurement kinds the user has marked "not applicable" for this
  // ingredient (e.g. volume on a count-only item). The DB column is non-null
  // with an empty-array default, so public read contracts always carry it.
  naKinds: z.array(baseKind),
  ...timestampedFields,
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
  product: z.array(productWithMappingsOut),
  appearsInRecipes: z.array(recipeRefOut),
  ownRecipeCount: z.number().int(),
});
export type IngredientListItem = z.infer<typeof ingredientListItemOut>;

/**
 * The image that represents an ingredient: the first displayable photo across
 * the products it maps to.
 *
 * An ingredient has no image relation of its own, so before this the leading
 * thumbnail column rendered the same carrot on every row — the linked products'
 * images were already joined by `relations.ingredient.list` and fetched on
 * every request, with nothing reading them.
 *
 * Scans ALL linked products rather than `product[0]`, so an ingredient whose
 * first product is unphotographed still shows a sibling's photo. The thumbnail
 * may therefore come from a different product than the one the PRODUCT column's
 * pill names: deliberate, because this column answers "what does this
 * ingredient look like", not "which SKU is canonical".
 *
 * Structurally typed rather than taking an `IngredientListItem`, so the list
 * row, the detail read and the hover-card view-model all satisfy it.
 */
export const ingredientCoverImage = (ing: {
  product: { images: ImageOut[] }[];
}): ImageOut | null =>
  firstDisplayableImage<ImageOut>(...ing.product.map((p) => p.images));

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
const ingredientCreateShape = {
  name: requiredName("Ingredient name")
    .describe("Ingredient name")
    .meta({ mock: "food.ingredient" }),
  aliases: ingredientBaseFields.aliases.default([]),
  naKinds: z.array(baseKind).optional().default([]),
};
export const ingredientCreateInput = z.object(ingredientCreateShape);
export type IngredientCreateInput = z.infer<typeof ingredientCreateInput>;

export const ingredientUpdateData = deriveUpdateData(ingredientCreateShape, {
  omit: ["name", "aliases"],
  extend: {
    name: requiredName("Ingredient name")
      .describe("New name")
      .meta({ mock: "food.ingredient" })
      .optional(),
    aliases: ingredientBaseFields.aliases
      .optional()
      .describe("New aliases (replaces existing list)"),
  },
});

export const ingredientUpdateInput = z.object({
  id: ingredientShortcode,
  data: ingredientUpdateData,
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;

export const ingredientMergeInput = z.object({
  keepId: ingredientShortcode,
  mergeIds: z.array(ingredientShortcode).min(1),
});

/**
 * Per-candidate merge preview: how much of the "worth keeping" signal each
 * ingredient carries. Powers the keeper picker (best-keeper default + the
 * counts shown per row) so the choice is informed, not selection-order. All
 * counts are non-negative; `hasUsdaLink` is true when any linked product has a
 * USDA-resolvable reference (explicit `fdc_id` or a UPC).
 */
export const ingredientMergeCandidateImpact = z.object({
  id: ingredientShortcode,
  name: z.string(),
  recipeUsageCount: z.number().int().nonnegative(),
  productCount: z.number().int().nonnegative(),
  aliasCount: z.number().int().nonnegative(),
  hasUsdaLink: z.boolean(),
});
export type IngredientMergeCandidateImpact = z.infer<
  typeof ingredientMergeCandidateImpact
>;

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

export const mcpIngredientCreateInput = z.object({
  name: ingredientCreateShape.name,
  aliases: ingredientCreateShape.aliases,
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
  products: z.array(z.object({ id: productShortcode, name: z.string() })),
  recipeCount: z.number().int().nonnegative(),
});
export type IngredientMcpOut = z.infer<typeof ingredientMcpOut>;

export const ingredientMcpListOut =
  createPaginatedResponseSchema(ingredientMcpOut);

export const ingredientResolveOrCreateResponseOut = z.object({
  results: ingredientResolveOrCreateOut,
});
