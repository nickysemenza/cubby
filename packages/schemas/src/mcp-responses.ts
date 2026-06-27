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
import { ingredientOut } from "./ingredient";
import {
  ingredientId,
  locationId,
  productId,
  recipeShortcode,
} from "./identifiers";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { mealOut, mealRecipeOut } from "./meal-responses";
import { productTopLevelOut } from "./product";
import { recipeTopLevel } from "./recipe-responses";
import { unitMappingOut } from "./unitmapping-responses";

export const mcpLocationOut = locationOut
  .pick({ id: true, name: true, shortcode: true, type: true })
  .extend({
    // Hierarchy as pointers, not nested objects. get_location / list_locations
    // both already carry parent + immediate children on the row, so these are
    // reachable in the same call; id+name is enough to navigate.
    parentName: z.string().nullable(),
    parentId: locationId.nullable(),
    children: z.array(z.object({ id: locationId, name: z.string() })),
  });
export type McpLocationOut = z.infer<typeof mcpLocationOut>;

export const mcpInventoryProductOut = productTopLevelOut.pick({
  id: true,
  name: true,
  manufacturer: true,
  shortcode: true,
});
export type McpInventoryProductOut = z.infer<typeof mcpInventoryProductOut>;

export const mcpInventoryLocationOut = locationOut.pick({
  id: true,
  name: true,
});
export type McpInventoryLocationOut = z.infer<typeof mcpInventoryLocationOut>;

export const mcpInventoryOut = inventoryEntryOut
  .pick({ id: true, amount: true, valuation: true })
  .extend({
    product: mcpInventoryProductOut.nullable(),
    location: mcpInventoryLocationOut.nullable(),
  });
export type McpInventoryOut = z.infer<typeof mcpInventoryOut>;

export const mcpProductUnitMappingOut = unitMappingOut.pick({
  a: true,
  b: true,
  source: true,
});
export type McpProductUnitMappingOut = z.infer<typeof mcpProductUnitMappingOut>;

export const mcpProductOut = productTopLevelOut
  .pick({
    id: true,
    name: true,
    shortcode: true,
    manufacturer: true,
    upc: true,
    category: true,
    price: true,
    expectedQuantity: true,
    fdc_id: true,
    usdaUnavailable: true,
    externalIds: true,
  })
  .extend({
    // USDA linkage is resolved at query time (explicit fdc_id, else UPC
    // auto-match) and surfaced as `food`; a non-null `usdaFdcId` is the
    // canonical linked signal, including UPC-only matches.
    usdaFdcId: z.number().nullable(),
    ingredientId: ingredientId.nullable(),
    unitMappings: z.array(mcpProductUnitMappingOut),
  });
export type McpProductOut = z.infer<typeof mcpProductOut>;

export const mcpRecipeOut = recipeTopLevel
  .pick({ id: true, name: true, yield: true, servings: true, tags: true })
  // recipeTopLevel does not model shortcode; recipe rows still carry it.
  .extend({ shortcode: recipeShortcode.nullish() });
export type McpRecipeOut = z.infer<typeof mcpRecipeOut>;

export const mcpIngredientProductOut = z.object({
  id: productId,
  name: z.string(),
});
export type McpIngredientProductOut = z.infer<typeof mcpIngredientProductOut>;

export const mcpIngredientOut = ingredientOut
  .pick({ id: true, name: true, aliases: true })
  .extend({
    products: z.array(mcpIngredientProductOut),
    recipeCount: z.number().int().nonnegative(),
    // Pointer to the ingredient's own USDA food link; reach it via get_usda_food.
    usdaFdcId: z.number().nullable(),
  });
export type McpIngredientOut = z.infer<typeof mcpIngredientOut>;

export const mcpMealRecipeOut = mealRecipeOut
  .pick({ id: true, recipeId: true, scale: true, scaledTotals: true })
  .extend({ name: z.string().nullable() });
export type McpMealRecipeOut = z.infer<typeof mcpMealRecipeOut>;

export const mcpMealOut = mealOut
  .pick({ id: true, date: true, name: true, sortOrder: true, totals: true })
  .extend({ recipes: z.array(mcpMealRecipeOut) });
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
