import {
  brandedFoodInfo,
  dataTypeEnum,
  fdcId,
  foodPortion,
  ndb,
  nutrientSummary,
  nutrientsPer100,
  upc,
} from "@cubby/usda-schemas";
import { z } from "zod";
import { amount } from "./codec";
import { externalIdOut } from "./external-id-responses";
import {
  ingredientId,
  inventoryId,
  locationId,
  locationShortcode,
  mealId,
  mealRecipeId,
  productId,
  productShortcode,
  recipeId,
  recipeShortcode,
} from "./identifiers";
import { locationType } from "./location";
import { mealDate, mealScale } from "./meal-shared";
import { mealTotals, scaledTotals } from "./meal-responses";
import { productCategory } from "./product";
import { recipeServings, recipeTags, recipeYieldSchema } from "./recipe-shared";

export const mcpLocationOut = z.object({
  id: locationId,
  name: z.string(),
  shortcode: locationShortcode,
  type: locationType,
  // Hierarchy as pointers, not nested objects. get_location / list_locations
  // both already carry parent + immediate children on the row, so these are
  // reachable in the same call; id+name is enough to navigate.
  parentName: z.string().nullable(),
  parentId: locationId.nullable(),
  children: z.array(z.object({ id: locationId, name: z.string() })),
});
export type McpLocationOut = z.infer<typeof mcpLocationOut>;

export const mcpInventoryProductOut = z.object({
  id: productId,
  name: z.string(),
  manufacturer: z.string(),
  shortcode: productShortcode,
});
export type McpInventoryProductOut = z.infer<typeof mcpInventoryProductOut>;

export const mcpInventoryLocationOut = z.object({
  id: locationId,
  name: z.string(),
});
export type McpInventoryLocationOut = z.infer<typeof mcpInventoryLocationOut>;

export const mcpInventoryOut = z.object({
  id: inventoryId,
  amount,
  valuation: z.number().nullable(),
  product: mcpInventoryProductOut.nullable(),
  location: mcpInventoryLocationOut.nullable(),
});
export type McpInventoryOut = z.infer<typeof mcpInventoryOut>;

export const mcpProductUnitMappingOut = z.object({
  a: amount,
  b: amount,
  source: z.string().nullable(),
});
export type McpProductUnitMappingOut = z.infer<typeof mcpProductUnitMappingOut>;

export const mcpProductOut = z.object({
  id: productId,
  name: z.string(),
  shortcode: productShortcode,
  manufacturer: z.string(),
  upc: upc.nullable(),
  category: productCategory.nullable(),
  price: z.number().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  fdc_id: fdcId.nullable(),
  usdaUnavailable: z.boolean().nullable(),
  externalIds: z.array(externalIdOut),
  // USDA linkage is resolved at query time (explicit fdc_id, else UPC
  // auto-match) and surfaced as `food`; a non-null `usdaFdcId` is the
  // canonical linked signal, including UPC-only matches.
  usdaFdcId: z.number().nullable(),
  ingredientId: ingredientId.nullable(),
  unitMappings: z.array(mcpProductUnitMappingOut),
});
export type McpProductOut = z.infer<typeof mcpProductOut>;

export const mcpRecipeOut = z.object({
  id: recipeId,
  name: z.string(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
  // recipeTopLevel does not model shortcode; recipe rows still carry it.
  shortcode: recipeShortcode.nullish(),
});
export type McpRecipeOut = z.infer<typeof mcpRecipeOut>;

export const mcpIngredientProductOut = z.object({
  id: productId,
  name: z.string(),
});
export type McpIngredientProductOut = z.infer<typeof mcpIngredientProductOut>;

export const mcpIngredientOut = z.object({
  id: ingredientId,
  name: z.string(),
  aliases: z.array(z.string()),
  products: z.array(mcpIngredientProductOut),
  recipeCount: z.number().int().nonnegative(),
  // Pointer to the ingredient's own USDA food link; reach it via get_usda_food.
  usdaFdcId: z.number().nullable(),
});
export type McpIngredientOut = z.infer<typeof mcpIngredientOut>;

export const mcpMealRecipeOut = z.object({
  id: mealRecipeId,
  recipeId,
  scale: mealScale,
  scaledTotals: scaledTotals.nullable(),
  name: z.string().nullable(),
});
export type McpMealRecipeOut = z.infer<typeof mcpMealRecipeOut>;

export const mcpMealOut = z.object({
  id: mealId,
  date: mealDate,
  name: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  totals: mealTotals,
  recipes: z.array(mcpMealRecipeOut),
});
export type McpMealOut = z.infer<typeof mcpMealOut>;

export const mcpUsdaFoodOut = z.object({
  fdc_id: fdcId,
  description: z.string().nullable(),
  data_type: dataTypeEnum.nullable(),
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  gtin_upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  ingredients: z.string().nullable(),
  // Branded serving + portion table + named nutrient summary are not reachable
  // through a separate MCP portion/nutrient decode tool.
  serving: brandedFoodInfo.shape.serving.nullable(),
  nutrientsPer100: nutrientsPer100.nullable(),
  nutrientSummary: z.array(nutrientSummary),
  portionInfoRaw: z.array(foodPortion),
  linkedProducts: z.array(z.object({ id: productId, name: z.string() })),
});
export type McpUsdaFoodOut = z.infer<typeof mcpUsdaFoodOut>;
