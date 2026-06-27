import { z } from "zod";
import { requiredName } from "./common";
import { ingredientId } from "./identifiers";
import { baseKind } from "./problems";

export const ingredientFields = z.object({
  // `mock` is a faker dot-path consumed by the test mock generator
  // (apps/web .../test/mock-schema.ts); it is plain metadata, faker-free here.
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
});

export const ingredientBase = ingredientFields;

/**
 * List/search filters for ingredients. Field names match the MCP
 * `search_ingredients` tool exactly; the MCP tool has its own explicit field
 * roster with matching names and descriptions.
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

export const mcpIngredientSearchInputShape = {
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
export const ingredientOut = z.object({
  id: ingredientId,
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
  // Base measurement kinds the user has marked "not applicable" for this
  // ingredient (e.g. volume on a count-only item). The DB column is non-null
  // with an empty-array default, so public read contracts always carry it.
  naKinds: z.array(baseKind),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type IngredientOut = z.infer<typeof ingredientOut>;

/**
 * Input schema for creating ingredients. Overrides the base `name` (lax for
 * reads) with a non-empty constraint; keep the mock hint for test fixtures.
 */
export const ingredientCreateInput = z.object({
  name: requiredName("Ingredient name").meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
  naKinds: z.array(baseKind).optional().default([]),
});
export type IngredientCreateInput = z.infer<typeof ingredientCreateInput>;

export const ingredientUpdateData = z.object({
  name: requiredName("Ingredient name")
    .meta({ mock: "food.ingredient" })
    .optional(),
  aliases: z.array(z.string()).optional(),
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

export const mcpIngredientCreateInputShape = {
  name: z.string().describe("Ingredient name"),
  aliases: z
    .array(z.string())
    .optional()
    .describe("Alternate names for this ingredient"),
};

export const mcpIngredientUpdateInputShape = {
  name: z.string().optional().describe("New name"),
  aliases: z.array(z.string()).optional().describe("New aliases (replaces)"),
};
