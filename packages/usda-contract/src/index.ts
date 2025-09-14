import { z } from "zod";
import { initContract } from "@ts-rest/core";
import {
  // core shared schemas
  foodSummary,
  nutrient_unit_name,
  foodLookupParam,
  type FoodSummary,
  type NutritionInfo,
  type FoodPortion,
  type BrandedFoodInfo,
  type LegacyFoodInfo,
} from "@recipehub/usda-schemas";

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
  dataTypeFilter: z.string().optional(),
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

const c = initContract();

export const usdaContract = c.router({
  health: {
    method: "GET",
    path: "/",
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
