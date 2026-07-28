import { z } from "zod";
import {
  dataTypeEnum,
  fdcId,
  foodPortion,
  ndb,
  nutrientSummary,
  nutrientsPer100,
  upc,
} from "@cubby/usda-schemas";
import { recipeAvailabilityListOut } from "./availability";
import { deletedCountOut } from "./common";
import { productId } from "./identifiers";
import {
  ingredientMcpListOut,
  ingredientMcpOut,
  ingredientMergeBatchOut,
  ingredientRawLinesBatchOut,
  ingredientResolveOrCreateResponseOut,
  mcpIngredientCreateInput,
  ingredientUpdateData,
  type IngredientMcpOut,
} from "./ingredient";
import {
  inventoryDuplicateFindOut,
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  inventoryMcpOut,
  type InventoryMcpOut,
} from "./inventory";
import {
  locationMcpListOut,
  locationMcpOut,
  mcpLocationCreateInput,
  locationUpdateData,
  type LocationMcpOut,
} from "./location";
import {
  mealMcpItemsOut,
  mealMcpListOut,
  mealMcpOut,
  mealAddRecipeInput,
  mealCreateInput,
  mealUpdateData,
  shoppingListOut,
  type MealMcpOut,
} from "./meal";
import { createPaginatedResponseSchema } from "./pagination";
import {
  allProblemsSchema,
  problemsCountSchema,
  reparseStaleSyncOut,
} from "./problems";
import {
  mcpProductCreateInput,
  mcpProductUpdateInput,
  productMcpListOut,
  productMcpOut,
  type ProductMcpOut,
} from "./product";
import {
  cookbookSummariesMcpOut,
  mcpRecipeCreateInput,
  mcpRecipeUpdateInput,
  recipeCostingExplain,
  recipeIdOut,
  recipeMcpListOut,
  recipeMcpOut,
  recipeOut,
  recipeRecomputeMcpOut,
  recipeTagsListOut,
  recipesUsingIngredientOut,
  type RecipeMcpOut,
} from "./recipe";
import {
  globalSearchInputSchema,
  globalSearchOut,
  similarEntitiesInputSchema,
  similarEntitiesOut,
} from "./search";
import { type McpUnitMappingInput, mcpUnitMappingInput } from "./unitmapping";
import { importRecipeSchema } from "./import-recipe";

export { type McpUnitMappingInput, mcpUnitMappingInput };

export {
  mcpIngredientCreateInput,
  ingredientUpdateData,
  mcpLocationCreateInput,
  locationUpdateData,
  mealAddRecipeInput,
  mealCreateInput,
  mealUpdateData,
  mcpProductCreateInput,
  mcpProductUpdateInput,
  mcpRecipeCreateInput,
  mcpRecipeUpdateInput,
};

export {
  ingredientMcpOut as mcpIngredientOut,
  inventoryMcpOut as mcpInventoryOut,
  locationMcpOut as mcpLocationOut,
  mealMcpOut as mcpMealOut,
  productMcpOut as mcpProductOut,
  recipeMcpOut as mcpRecipeOut,
};

export type {
  IngredientMcpOut as McpIngredientOut,
  InventoryMcpOut as McpInventoryOut,
  LocationMcpOut as McpLocationOut,
  MealMcpOut as McpMealOut,
  ProductMcpOut as McpProductOut,
  RecipeMcpOut as McpRecipeOut,
};

const mcpBrandedServingOut = z.object({
  serving_size: z.number().nullable(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
});

/** Everything a USDA food carries in both the search and detail shapes. */
const usdaFoodSharedFields = {
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
  portionInfoRaw: z.array(foodPortion),
  linkedProducts: z.array(z.object({ id: productId, name: z.string() })),
};

export const mcpUsdaFoodOut = z.object({
  ...usdaFoodSharedFields,
  nutrientSummary: z.array(nutrientSummary),
});
export type McpUsdaFoodOut = z.infer<typeof mcpUsdaFoodOut>;

/**
 * Search-result shape: the detail shape minus `nutrientSummary`.
 *
 * That field is the full USDA nutrient table — 115 entries on an SR Legacy row,
 * every individual fatty acid and amino acid and all four tocotrienols. It was
 * **87% of a ten-result response** (41.8KB of 47.9KB), dwarfing the compact
 * `nutrientsPer100` that carries the same macros keyed by nutrient code in
 * ~260B. Nothing reads it from a search result — the picker renders
 * `nutrientsPer100`, and an agent choosing between foods needs a name and macros,
 * not tocopherol beta. `get_usda_food` still returns it for the one food you
 * settled on.
 */
export const mcpUsdaFoodListItemOut = z.object(usdaFoodSharedFields);
export type McpUsdaFoodListItemOut = z.infer<typeof mcpUsdaFoodListItemOut>;

export const usdaFoodMcpListOut = createPaginatedResponseSchema(
  mcpUsdaFoodListItemOut,
);

export const usdaFoodMcpOut = mcpUsdaFoodOut.nullable();

export {
  ingredientMcpOut,
  inventoryMcpOut,
  locationMcpOut,
  mealMcpOut,
  productMcpOut,
  recipeMcpOut,
  ingredientMcpListOut,
  ingredientMergeBatchOut,
  ingredientRawLinesBatchOut,
  ingredientResolveOrCreateResponseOut,
  inventoryDuplicateFindOut,
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  locationMcpListOut,
  mealMcpItemsOut,
  mealMcpListOut,
  productMcpListOut,
  recipeMcpListOut,
  cookbookSummariesMcpOut,
  recipeTagsListOut,
  recipesUsingIngredientOut,
  recipeIdOut,
  recipeRecomputeMcpOut,
  shoppingListOut,
  deletedCountOut,
  problemsCountSchema,
  allProblemsSchema,
  reparseStaleSyncOut,
};

export const globalSearchMcpOut = z.object({ results: globalSearchOut });

/** find_similar_entities — already a `{ source, results }` object, so the MCP
 * shape is the router output verbatim (each result carries its similarity). */
export const similarEntitiesMcpOut = similarEntitiesOut;

export { globalSearchInputSchema, similarEntitiesInputSchema };

export const recipeAvailabilityMcpOut = z.object({
  recipes: recipeAvailabilityListOut,
});

export const scrapeRecipeMcpOut = importRecipeSchema;

export const recipeDetailMcpOut = recipeOut;

export const recipeCostingExplainMcpOut = recipeCostingExplain;

export const problemsTypeSliceOut = z.object({
  type: z.string(),
  items: z.array(z.unknown()),
});

export const problemsUnknownTypeOut = z.object({
  error: z.string(),
  availableTypes: z.array(z.string()),
});
