import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { ingredientId } from "./identifiers";
import { baseKind } from "./problems";

export const ingredientBase = z.object({
  // `mock` is a faker dot-path consumed by the test mock generator
  // (apps/web .../test/mock-schema.ts); it is plain metadata, faker-free here.
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
  // Base measurement kinds the user has marked "not applicable" for this
  // ingredient (e.g. volume on a count-only item). Optional everywhere (the DB
  // column defaults to '{}', so reads always have it); the coverage layer
  // subtracts these from the graded universe. See the `naKinds` column in
  // schema.ts and `gradedKinds` in conversion-coverage.
  naKinds: z.array(baseKind).optional(),
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
