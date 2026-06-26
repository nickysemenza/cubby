import { z } from "zod";
import { amount } from "./codec";
import { dbTimestampsOut, requiredName } from "./common";
import { id, ingredientId, recipeId } from "./identifiers";
import { baseKind } from "./problems";

export const ingredientFields = z.object({
  // `mock` is a faker dot-path consumed by the test mock generator
  // (apps/web .../test/mock-schema.ts); it is plain metadata, faker-free here.
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
});

export const ingredientBase = ingredientFields;

const ingredientPersistedFields = ingredientFields.extend({
  // Base measurement kinds the user has marked "not applicable" for this
  // ingredient (e.g. volume on a count-only item). The DB column is non-null
  // with an empty-array default, so public read contracts always carry it.
  naKinds: z.array(baseKind),
});

/**
 * List/search filters for ingredients. Field names match the MCP
 * `search_ingredients` tool exactly, so it reuses this schema's `.shape`
 * (descriptions and all) instead of re-declaring the fields.
 */
export const ingredientFiltersSchema = z.object({
  nameFilter: z
    .string()
    .optional()
    .describe("Filter by ingredient name (substring)"),
  missingProductsOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe("Only return ingredients with no linked products"),
});
export type IngredientFilters = z.infer<typeof ingredientFiltersSchema>;
export const ingredientOut = z
  .object({
    id: ingredientId,
  })
  .extend(ingredientPersistedFields.shape)
  .extend(dbTimestampsOut.shape);

/**
 * Input schema for creating ingredients. Overrides the base `name` (lax for
 * reads) with a non-empty constraint; keep the mock hint for test fixtures.
 */
export const ingredientCreateInput = ingredientBase.extend({
  name: requiredName("Ingredient name").meta({ mock: "food.ingredient" }),
  naKinds: z.array(baseKind).optional().default([]),
});
export type IngredientCreateInput = z.infer<typeof ingredientCreateInput>;

export const ingredientUpdateData = ingredientFields
  .extend({
    name: requiredName("Ingredient name").meta({ mock: "food.ingredient" }),
    naKinds: z.array(baseKind),
  })
  .partial();

/**
 * Input schema for updating ingredients
 *
 */
export const ingredientUpdateInput = z.object({
  id: ingredientId,
  data: ingredientUpdateData,
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;

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
