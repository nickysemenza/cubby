import { z } from "zod";
import { initContract } from "@ts-rest/core";
import {
  // core shared schemas
  fdcId,
  foodSummary,
  nutrient_unit_name,
  dataTypeEnum,
  foodLookupParam,
  type FoodSummary,
  type NutritionInfo,
  type FoodPortion,
  type BrandedFoodInfo,
  type LegacyFoodInfo,
} from "@cubby/usda-schemas";

// API-specific schemas (compose from shared)
export const countsSchema = z.object({
  usda_food: z.number().int().min(0),
  usda_branded_food: z.number().int().min(0),
  usda_nutrient: z.number().int().min(0),
  usda_food_nutrient: z.number().int().min(0),
  usda_measure_unit: z.number().int().min(0),
  usda_food_portion: z.number().int().min(0),
  usda_sr_legacy_food: z.number().int().min(0),
});

export const errorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export const DEFAULT_LIST_FOODS_PAGE_INDEX = 0;
export const DEFAULT_LIST_FOODS_PAGE_SIZE = 10;
export const MAX_LIST_FOODS_PAGE_SIZE = 1000;
export const MAX_BATCH_LOOKUP_SIZE = 1000;

export const listFoodsQuery = z.object({
  nameFilter: z.string().optional(),
  dataTypeFilter: dataTypeEnum.optional(),
  // Comma-joined data types for multi-type filtering (e.g. "generic" = all
  // non-branded food types). A querystring is always a string, so this is the
  // serialized form; the single `dataTypeFilter` takes precedence over it.
  dataTypes: z.string().optional(),
  // Restrict to the four user-facing food types (branded / foundation / SR
  // legacy / survey), hiding the Foundation sampling pipeline + experimental
  // records. An explicit dataTypeFilter takes precedence. Union so the web
  // client can pass a real boolean while the HTTP querystring (always a string)
  // parses correctly — unlike z.coerce.boolean(), which turns "false" into true.
  foodsOnly: z.union([z.boolean(), z.stringbool()]).optional(),
  orderBy: z
    .enum(["description", "data_type", "fdc_id", "relevance"])
    .optional()
    .default("description"),
  direction: z.enum(["asc", "desc"]).optional().default("asc"),
  pageIndex: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_LIST_FOODS_PAGE_INDEX),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_FOODS_PAGE_SIZE)
    .default(DEFAULT_LIST_FOODS_PAGE_SIZE),
});

export const listFoodsResponse = z.object({
  data: z.array(foodSummary),
  count: z.number(),
});

// Derived directly from the validation boundary: the route hands the PARSED
// query (defaults applied) straight to `dataSource.listFoods`, so the inferred
// output type — where `orderBy`/`direction`/`pageIndex`/`pageSize` are always
// present — is strictly more accurate than a hand-written interface.
export type ListFoodsArgs = z.infer<typeof listFoodsQuery>;
export type ListFoodsResult = z.infer<typeof listFoodsResponse>;

// Path params
// Path param: arrives as a string, so coerce then validate as a real fdcId.
export const fdcIdParam = z.object({ fdc_id: z.coerce.number().pipe(fdcId) });

// Pre-define batch schemas to avoid ts-rest type depth issues
export const batchLookupBody = z.object({
  lookups: z.array(foodLookupParam).max(MAX_BATCH_LOOKUP_SIZE),
});

export const batchLookupResponse = z.object({
  results: z.array(foodSummary.nullable()),
});

const c = initContract();

export const usdaContract = c.router({
  counts: {
    method: "GET",
    path: "/counts",
    responses: {
      200: countsSchema,
      500: errorSchema,
    },
    summary: "Get database table counts",
  },
  getFood: {
    method: "GET",
    path: "/api/foods/:fdc_id",
    pathParams: fdcIdParam,
    responses: {
      200: foodSummary,
      404: errorSchema,
    },
    summary: "Get complete food by FDC ID",
  },
  findByLookup: {
    method: "POST",
    path: "/api/foods/search",
    body: foodLookupParam,
    responses: {
      200: foodSummary.nullable(),
    },
    summary: "Find complete food by lookup (UPC or NDB) via POST body",
  },
  findByLookupBatch: {
    method: "POST",
    path: "/api/foods/search/batch",
    // Use pre-defined schemas to avoid ts-rest type depth issues
    body: batchLookupBody,
    responses: {
      200: batchLookupResponse,
    },
    summary: "Find multiple foods by lookup (UPC or NDB) in batch",
  },
  listFoods: {
    method: "GET",
    path: "/api/foods",
    query: listFoodsQuery,
    responses: {
      200: listFoodsResponse,
    },
    summary: "List foods with pagination and filtering",
  },
});

export type {
  FoodSummary,
  NutritionInfo,
  FoodPortion,
  BrandedFoodInfo,
  LegacyFoodInfo,
};
export { nutrient_unit_name };
