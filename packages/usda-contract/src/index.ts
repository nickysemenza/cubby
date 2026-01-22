import { z } from "zod";
import { initContract } from "@ts-rest/core";
import {
  // core shared schemas
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

export const listFoodsQuery = z.object({
  nameFilter: z.string().optional(),
  dataTypeFilter: dataTypeEnum.optional(),
  orderBy: z
    .enum(["description", "data_type", "fdc_id"])
    .optional()
    .default("description"),
  direction: z.enum(["asc", "desc"]).optional().default("asc"),
  pageIndex: z.coerce.number().default(0),
  pageSize: z.coerce.number().default(10),
});

export const listFoodsResponse = z.object({
  data: z.array(foodSummary),
  count: z.number(),
});

// Path params
export const fdcIdParam = z.object({ fdc_id: z.coerce.number() });

// Pre-define batch schemas to avoid ts-rest type depth issues
export const batchLookupBody = z.object({
  lookups: z.array(foodLookupParam),
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
