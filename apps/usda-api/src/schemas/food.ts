import { z } from "zod";
import {
  brandedFoodInfo,
  legacyFoodInfo,
  foodPortion,
  nutrient_unit_name,
  nutritionInfo,
  NutritionInfo,
  FoodSummary,
  BrandedFoodInfo,
  LegacyFoodInfo,
  FoodPortion,
  NutrientSummary,
} from "@recipehub/usda-schemas";

// Re-export shared schemas for convenience
export {
  nutrient_unit_name,
  nutritionInfo,
  type NutritionInfo,
  type FoodSummary,
  type BrandedFoodInfo,
  type LegacyFoodInfo,
  type FoodPortion,
  type NutrientSummary,
};

// Base food info schema (API-specific)
const foodInfo = z.object({
  fdc_id: z.number(),
  data_type: z.string(),
  description: z.string().nullable(),
});

// API Response Schemas

// Composite Route (Complete Food Response)
export const getCompleteFoodResponse = z.object({
  fdc_id: z.number(),
  foodInfo: foodInfo.omit({ fdc_id: true }),
  brandedFoodInfo: brandedFoodInfo.nullable(),
  legacyFoodInfo: legacyFoodInfo.nullable(),
  nutritionInfo: nutritionInfo,
  portionInfo: z.object({
    raw: z.array(foodPortion),
  }),
});

// 6. Find Food by UPC - now returns complete food data
export const findFoodByUpcResponse = getCompleteFoodResponse.nullable();

// 7. Find Food by NDB Number - now returns complete food data
export const findFoodByNdbResponse = getCompleteFoodResponse.nullable();

// 8. List Foods with Pagination and Filtering
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
  data: z.array(getCompleteFoodResponse),
  count: z.number(),
});

// Error response schema
export const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});
