import { z } from "zod";
import { projectShortcode } from "./identifiers";
import { productRefOut } from "./product-fields";
import { paginatedMetaSchema } from "./pagination";
import {
  dataTypeEnum,
  fdcId,
  foodPortion,
  ndb,
  nutrientSummary,
  nutrientsPer100,
} from "@cubby/usda";
import { upc } from "@cubby/shared/upc";
import { recipeAvailabilityListOut } from "./availability";
import { deletedCountOut } from "./common";
import {
  ingredientMcpListOut,
  ingredientMcpOut,
  type IngredientMcpOut,
} from "./ingredient";
import { ingredientUpdateData } from "@cubby/schemas/entities/ingredient";
import { locationUpdateData } from "@cubby/schemas/entities/location";
import { mealAddRecipeInput, shoppingListOut } from "./meal";
import { mealCreateInput, mealUpdateData } from "@cubby/schemas/entities/meal";
import { createPaginatedResponseSchema } from "./pagination";
import {
  allProblemsMcpSchema,
  allProblemsSchema,
  problemsCountSchema,
} from "./problems";

import { measureEstimate } from "./nutrition";
import {
  recipeCostingExplain,
  recipeIdOut,
  recipesUsingIngredientOut,
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

export { ingredientMcpOut as mcpIngredientOut };

export type { IngredientMcpOut as McpIngredientOut };

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
  linkedProducts: z.array(productRefOut),
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
 * not tocopherol beta. `usda_food.by_fdc_id` still returns it for the one food you
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
  ingredientMcpListOut,
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

export const recipeCostingExplainDetail = z.enum(["full", "lines"]);
export type RecipeCostingExplainDetail = z.infer<
  typeof recipeCostingExplainDetail
>;

/**
 * `recipe_insights_read.costing_explanation` with `detail: "lines"`: the per-line diagnostics
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

/**
 * A detector row as the wire carries it. Detectors return typed rows (with
 * `Date` timestamps); the MCP result and Start transport carry their JSON form,
 * so the row is normalized exactly as `JSON.stringify` would before validating.
 */
const problemItem = z.preprocess(
  (row) => (row === undefined ? row : JSON.parse(JSON.stringify(row))),
  z.json(),
);

export const problemsTypeSliceOut = z.object({
  type: z.string(),
  items: z.array(problemItem),
  /** Known findings only while incompleteProjectIds is nonempty. */
  total: z.number().int(),
  incompleteProjectIds: z.array(projectShortcode).optional(),
  meta: paginatedMetaSchema
    .extend({ pageSize: z.number().int().positive().max(100) })
    .optional(),
});

export const problemsUnknownTypeOut = z.object({
  error: z.string(),
  availableTypes: z.array(z.string()),
});
