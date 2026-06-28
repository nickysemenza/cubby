import {
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
import { externalIdOut } from "./external-id";
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
import {
  mcpIngredientCreateInputShape,
  mcpIngredientSearchInputShape,
  mcpIngredientUpdateInputShape,
} from "./ingredient";
import {
  locationType,
  mcpLocationCreateInputShape,
  mcpLocationUpdateInputShape,
} from "./location";
import {
  mcpMealAddRecipeInputShape,
  mcpMealCreateInputShape,
  mcpMealUpdateInputShape,
} from "./meal";
import { mealDate, mealScale } from "./meal-shared";
import { mealTotals, scaledTotals } from "./meal";
import {
  mcpProductCreateInputShape,
  mcpProductUpdateInputShape,
  productCategory,
} from "./product";
import { mcpRecipeCreateInputShape, mcpRecipeUpdateInputShape } from "./recipe";
import { recipeServings, recipeTags, recipeYieldSchema } from "./recipe-shared";
import { type McpUnitMappingInput, mcpUnitMappingInput } from "./unitmapping";

export {
  type McpUnitMappingInput,
  mcpIngredientCreateInputShape,
  mcpIngredientSearchInputShape,
  mcpIngredientUpdateInputShape,
  mcpLocationCreateInputShape,
  mcpLocationUpdateInputShape,
  mcpMealAddRecipeInputShape,
  mcpMealCreateInputShape,
  mcpMealUpdateInputShape,
  mcpProductCreateInputShape,
  mcpProductUpdateInputShape,
  mcpRecipeCreateInputShape,
  mcpRecipeUpdateInputShape,
  mcpUnitMappingInput,
};

export const mcpLocationOut = z.object({
  id: locationId,
  name: z.string(),
  shortcode: locationShortcode,
  type: locationType,
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

const mcpBrandedServingOut = z.object({
  serving_size: z.number().nullable(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
});

export const mcpUsdaFoodOut = z.object({
  fdc_id: fdcId,
  description: z.string().nullable(),
  data_type: dataTypeEnum.nullable(),
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  gtin_upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  ingredients: z.string().nullable(),
  serving: mcpBrandedServingOut.nullable(),
  nutrientsPer100: nutrientsPer100.nullable(),
  nutrientSummary: z.array(nutrientSummary),
  portionInfoRaw: z.array(foodPortion),
  linkedProducts: z.array(z.object({ id: productId, name: z.string() })),
});
export type McpUsdaFoodOut = z.infer<typeof mcpUsdaFoodOut>;
