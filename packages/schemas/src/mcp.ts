import { z } from "zod";
import { paginatedMetaSchema } from "./pagination";
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
import { productShortcode } from "./identifiers";
import {
  ingredientMcpListOut,
  ingredientMcpOut,
  ingredientUpdateData,
  type IngredientMcpOut,
} from "./ingredient";
import {
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  inventoryMcpOut,
  type InventoryMcpOut,
} from "./inventory";
import {
  locationMcpListOut,
  locationMcpOut,
  locationUpdateData,
  type LocationMcpOut,
} from "./location";
import {
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
  allProblemsMcpSchema,
  allProblemsSchema,
  problemsCountSchema,
} from "./problems";
import {
  productMcpListOut,
  productMcpOut,
  type ProductMcpOut,
} from "./product";
import { measureEstimate } from "./nutrition";
import {
  recipeCostingExplain,
  recipeIdOut,
  recipeMcpListOut,
  recipeMcpOut,
  recipeOut,
  recipesUsingIngredientOut,
  type RecipeMcpOut,
} from "./recipe";
import {
  searchHitsOut,
  searchQueryInputFields,
  similarEntitiesInputSchema,
  similarEntitiesOut,
} from "./search";
import { type McpUnitMappingInput, mcpUnitMappingInput } from "./unitmapping";
import { importRecipeSchema } from "./import-recipe";

export { type McpUnitMappingInput, mcpUnitMappingInput };

export {
  ingredientUpdateData,
  locationUpdateData,
  mealAddRecipeInput,
  mealCreateInput,
  mealUpdateData,
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

const usdaFoodSharedFields = {
  // USDA FoodData Central id — declared exception, USDA's own public id and
  // not a cubby shortcode; this IS the entity's id at the MCP boundary.
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
  linkedProducts: z.array(z.object({ id: productShortcode, name: z.string() })),
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
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  locationMcpListOut,
  mealMcpListOut,
  productMcpListOut,
  recipeMcpListOut,
  recipesUsingIngredientOut,
  recipeIdOut,
  shoppingListOut,
  deletedCountOut,
  problemsCountSchema,
  allProblemsSchema,
  allProblemsMcpSchema,
};

export const globalSearchMcpInputSchema = z.object({
  ...searchQueryInputFields,
  includeRelated: z
    .boolean()
    .default(false)
    .describe("Include semantic related results in a separate result section."),
});

export const globalSearchMcpOut = z.object({
  results: searchHitsOut,
  related: searchHitsOut,
  relatedStatus: z.enum(["not_requested", "ready", "unavailable"]),
});

export const similarEntitiesMcpOut = similarEntitiesOut;

export { similarEntitiesInputSchema };

export const recipeAvailabilityMcpOut = z.object({
  recipes: recipeAvailabilityListOut,
});

export const scrapeRecipeMcpOut = importRecipeSchema;

export const recipeDetailMcpOut = recipeOut;

export const recipeCostingExplainDetail = z.enum(["full", "lines"]);
export type RecipeCostingExplainDetail = z.infer<
  typeof recipeCostingExplainDetail
>;

/**
 * `explain_recipe_costing` with `detail: "lines"`: the per-line diagnostics
 * without the two 22-nutrient totals blocks and the drift record. The totals
 * are what `entity get recipe` already returns; an agent chasing "which line
 * is uncovered" only needs the diagnostics plus a coverage headline.
 */
export const recipeCostingExplainLinesOut = z.object({
  detail: z.literal("lines"),
  persisted: recipeCostingExplain.shape.persisted.omit({ totals: true }),
  computed: recipeCostingExplain.shape.computed.omit({ totals: true }),
  coverage: z.object({
    cost: measureEstimate,
    kcal: measureEstimate,
  }),
});
export type RecipeCostingExplainLinesOut = z.infer<
  typeof recipeCostingExplainLinesOut
>;

export const recipeCostingExplainMcpOut = z.union([
  recipeCostingExplain.extend({ detail: z.literal("full").optional() }),
  recipeCostingExplainLinesOut,
]);

export const problemsTypeSliceOut = z.object({
  type: z.string(),
  items: z.array(z.unknown()),
  total: z.number().int(),
  meta: paginatedMetaSchema
    .extend({ pageSize: z.number().int().positive().max(100) })
    .optional(),
});

export const problemsUnknownTypeOut = z.object({
  error: z.string(),
  availableTypes: z.array(z.string()),
});
