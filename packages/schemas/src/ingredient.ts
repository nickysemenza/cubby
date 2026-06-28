import { z } from "zod";
import { amount } from "./codec";
import { requiredName } from "./common";
import { id, ingredientId, recipeId } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
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

export const ingredientFields = z.object(ingredientBaseFields);

export const ingredientBase = ingredientFields;

/**
 * List/search filters for ingredients. Field names match the MCP
 * `search_ingredients` tool exactly; the MCP tool has its own explicit field
 * roster with matching names and descriptions.
 */
export const ingredientFilterFields = {
  nameFilter: z
    .string()
    .optional()
    .describe("Filter by ingredient name (substring)"),
  missingProductsOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe("Only return ingredients with no linked products"),
};

export const ingredientFiltersSchema = z.object(ingredientFilterFields);
export type IngredientFilters = z.infer<typeof ingredientFiltersSchema>;

export const ingredientSortableFields = [
  "createdAt",
  "name",
  "appearsInRecipes",
  "product",
] as const;

export type IngredientSortField = (typeof ingredientSortableFields)[number];

export const ingredientOutFields = {
  id: ingredientId,
  ...ingredientBaseFields,
  // Base measurement kinds the user has marked "not applicable" for this
  // ingredient (e.g. volume on a count-only item). The DB column is non-null
  // with an empty-array default, so public read contracts always carry it.
  naKinds: z.array(baseKind),
  createdAt: z.date(),
  updatedAt: z.date(),
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
  /** Distinct recipes that had a line re-pointed onto the target. */
  recipesMoved: z.number().int().nonnegative(),
  /** Product rows re-pointed onto the target (incl. soft-deleted). */
  productsMoved: z.number().int().nonnegative(),
  /** Ingredient ids absorbed and hard-deleted. */
  deletedIds: z.array(ingredientId),
});
export type MergeSummaryOut = z.infer<typeof mergeSummary>;

export const ingredientRawLineOut = z.object({
  ingredientId,
  lineId: id,
  rawLine: z.string().nullable(),
  modifier: z.string().nullable(),
  amounts: z.array(amount),
  recipeId,
  recipeName: z.string(),
  sectionName: z.string().nullable(),
});
export type IngredientRawLineOut = z.infer<typeof ingredientRawLineOut>;

export const ingredientRecipeUsagesOut = z.array(recipeUsageOut);

export const ingredientRawLinesOut = z.array(ingredientRawLineOut);

export const ingredientMatchOut = z
  .object({
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
  })
  .nullable();

export const ingredientMatchesOut = z.record(z.string(), ingredientMatchOut);

export const ingredientResolveOrCreateResultOut = z.object({
  name: z.string(),
  id: ingredientId,
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

// Lean ingredient+food shape: products (with food) without the per-usage recipe
// bodies that detail responses carry. Used by workbench and costing paths.
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
});
export type IngredientListItem = z.infer<typeof ingredientListItemOut>;

/** The single highest-leverage fix for an ingredient, or "done" when complete. */
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
  // Every live recipe using this ingredient is book-sourced. Computed in SQL.
  cookbookOnly: z.boolean(),
  coverage: z.object({
    covered: z.array(baseKind),
    // Kinds graded against (all four minus this ingredient's N/A opt-outs).
    applicable: z.array(baseKind),
    tier: z.enum(["complete", "good", "partial", "none"]),
  }),
  recommendedFix: enrichmentFixKind,
  priceMode: z.enum(["per-each", "package"]),
  mergeCandidates: z.array(
    z.object({
      id: ingredientId,
      name: z.string(),
      // pg_trgm similarity (0-1) to this row.
      similarity: z.number(),
    }),
  ),
});
export type EnrichmentRow = z.infer<typeof enrichmentRowOut>;

export const enrichmentRowsOut = z.array(enrichmentRowOut);

export const ingredientWithFoodLeanListOut = z.array(ingredientWithFoodLeanOut);

/**
 * Input schema for creating ingredients. Overrides the base `name` (lax for
 * reads) with a non-empty constraint; keep the mock hint for test fixtures.
 */
export const ingredientCreateInput = z.object({
  name: requiredName("Ingredient name")
    .describe("Ingredient name")
    .meta({ mock: "food.ingredient" }),
  aliases: ingredientBaseFields.aliases.default([]),
  naKinds: z.array(baseKind).optional().default([]),
});
export type IngredientCreateInput = z.infer<typeof ingredientCreateInput>;

export const ingredientUpdateData = z.object({
  name: requiredName("Ingredient name")
    .describe("New name")
    .meta({ mock: "food.ingredient" })
    .optional(),
  aliases: ingredientBaseFields.aliases
    .optional()
    .describe("New aliases (replaces existing list)"),
  naKinds: z.array(baseKind).optional(),
});

/**
 * Input schema for updating ingredients
 *
 */
export const ingredientUpdateInput = z.object({
  id: ingredientId,
  data: ingredientUpdateData,
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;

export const ingredientMergeInput = z.object({
  target: ingredientId,
  aliases: z.array(ingredientId).min(1),
  // Validate + count what would change without writing.
  dryRun: z.boolean().optional(),
});

export const ingredientIdInput = z.object({
  id: ingredientId,
});

export const ingredientIdsInput = z.object({
  ids: z.array(ingredientId),
});

export const ingredientRawLinesInput = z.object({
  ids: z.array(ingredientId).min(1),
});

export const ingredientNameFilterInput = z.object({
  nameFilter: z.string(),
});

export const ingredientNamesInput = z.object({
  names: z.array(z.string()),
});

export const ingredientResolvableNamesInput = z.object({
  names: z.array(z.string().min(1)),
});

export const mcpIngredientCreateInput = z.object({
  name: requiredName("Ingredient name")
    .describe("Ingredient name")
    .meta({ mock: "food.ingredient" }),
  aliases: ingredientBaseFields.aliases.default([]),
});
export const mcpIngredientUpdateInput = ingredientUpdateData;

const ingredientMcpProductRefFields = {
  id: z.string(),
  name: z.string(),
};

/** Slim MCP projection of an ingredient list/detail row. */
export const ingredientMcpOut = z.object({
  id: ingredientId,
  name: z.string(),
  aliases: z.array(z.string()),
  products: z.array(z.object(ingredientMcpProductRefFields)),
  recipeCount: z.number().int().nonnegative(),
  usdaFdcId: z.number().nullable(),
});
export type IngredientMcpOut = z.infer<typeof ingredientMcpOut>;

export const ingredientMcpListOut =
  createPaginatedResponseSchema(ingredientMcpOut);

export const ingredientResolveOrCreateResponseOut = z.object({
  results: ingredientResolveOrCreateOut,
});

export const ingredientMergeBatchInput = z.object({
  merges: z
    .array(
      z.object({
        target: ingredientId.describe("ID of the ingredient to keep"),
        aliases: z
          .array(ingredientId)
          .min(1)
          .describe("IDs of duplicate ingredients to fold into the target"),
      }),
    )
    .min(1)
    .describe("One entry per duplicate cluster to merge"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Validate ids and report what each cluster WOULD change, without writing.",
    ),
});

export const ingredientMergeBatchOut = z.object({
  merged: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      target: ingredientId,
      ok: z.boolean(),
      summary: mergeSummary.optional(),
      error: z.string().optional(),
    }),
  ),
});

export const ingredientRawLineMcpOut = z.object({
  lineId: id,
  rawLine: z.string().nullable(),
  modifier: z.string().nullable(),
  amounts: z.array(amount),
  recipeId,
  recipeName: z.string(),
  sectionName: z.string().nullable(),
});

export const ingredientRawLinesBatchOut = z.object({
  count: z.number().int().nonnegative(),
  ingredients: z.array(
    z.object({
      ingredientId: ingredientId,
      lineCount: z.number().int().nonnegative(),
      lines: z.array(ingredientRawLineMcpOut),
    }),
  ),
});
