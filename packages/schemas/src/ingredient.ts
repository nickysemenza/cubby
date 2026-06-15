import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { ingredientId } from "./identifiers";

export const ingredientBase = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
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
  .extend(ingredientBase.shape)
  .extend(dbTimestampsOut.shape);

/**
 * Input schema for updating ingredients
 *
 */
export const ingredientUpdateInput = z.object({
  id: ingredientId,
  data: ingredientBase.partial(),
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;
