import { rawRecipeMcpReference } from "./recipe-raw-read";
import { ingredientShortcode } from "./identifier-fields";
import { baseKind } from "./problems";
/** Repository/compiler projections. Public Ingredient reads use generated envelopes. */
import definition from "./entity-definitions/02-ingredient.entity";
import { z } from "zod";
import {
  rawProductWithMappings,
  rawProductWithMappingsAndFood,
  rawProductMcpWithMappings,
  rawProductMcpWithMappingsAndFood,
} from "./product-raw-read";
import { rawRecipeTopLevel, recipeRefOut } from "./recipe-shared";
import { recipeUsageOut, recipeUsageMcpEntityOut } from "./recipe-fields";

export const rawIngredientOutput = definition.readSchemas.output;
export const rawIngredientList = definition.readSchemas.list;
export const rawIngredientDetail = definition.readSchemas.detail;
export const rawIngredientMcpList = rawIngredientList.extend({
  product: z.array(rawProductMcpWithMappings),
});
export const rawIngredientMcpDetail = rawIngredientDetail.extend({
  recipe: rawRecipeMcpReference.nullable(),
  recipeUsages: z.array(recipeUsageMcpEntityOut),
  product: z.array(rawProductMcpWithMappingsAndFood),
});
export const rawIngredientWithRecipesAndProduct = rawIngredientOutput.extend({
  recipe: rawRecipeTopLevel.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  appearsInRecipes: z.array(recipeRefOut),
  product: z.array(rawProductWithMappings),
});
export const rawIngredientWithFoodLean = rawIngredientOutput.extend({
  product: z.array(rawProductWithMappingsAndFood),
});
export type RawIngredientOutput = z.output<typeof rawIngredientOutput>;
export type RawIngredientList = z.output<typeof rawIngredientList>;
export type RawIngredientDetail = z.output<typeof rawIngredientDetail>;
export type RawIngredientWithRecipesAndProduct = z.output<
  typeof rawIngredientWithRecipesAndProduct
>;
export type RawIngredientWithFoodLean = z.output<
  typeof rawIngredientWithFoodLean
>;

export const enrichmentFixKind = z.enum([
  "no-product",
  "link-usda",
  "set-per-item-price",
  "add-purchase-mapping",
  "add-weight-mapping",
  "add-volume-mapping",
  "done",
]);

export const rawIngredientEnrichment = rawIngredientWithFoodLean.extend({
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
export type RawIngredientEnrichment = z.output<typeof rawIngredientEnrichment>;
