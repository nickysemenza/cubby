import { z } from "zod";

// Nutrient unit names enum based on database values
export const nutrient_unit_name = z.enum([
  "G",
  "IU", 
  "KCAL",
  "MCG_RE",
  "MG",
  "MG_ATE",
  "MG_GAE",
  "PH",
  "SP_GR",
  "UG",
  "UMOL_TE",
  "kJ"
]);

// Base food info schema
export const foodInfo = z.object({
  fdc_id: z.number(),
  data_type: z.string(),
  description: z.string().nullable(),
});

// Food summary schema for listings
export const foodSummary = z.object({
  fdc_id: z.number(),
  data_type: z.string(),
  description: z.string().nullable(),
});

// Legacy food info schema
export const legacyFoodInfo = z.object({
  fdc_id: z.number(),
  ndb_number: z.number(),
});

// Food portion schema
export const foodPortion = z.object({
  amount: z.number(),
  modifier: z.string().nullable(),
  gram_weight: z.number(),
});

// Nutrient info schema
export const nutrientInfo = z.object({
  amount: z.number(),
  name: z.string(),
  unit: nutrient_unit_name,
});

// Branded food info schema (without fdc_id for composite responses)
// Now matches database schema exactly
export const brandedFoodInfo = z.object({
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  branded_food_category: z.string().nullable(),
  gtin_upc: z.string(),
  ingredients: z.string().nullable(),
  serving: z.object({
    serving_size: z.number().nullable(),
    serving_size_unit: z.string().nullable(),
    household_serving_fulltext: z.string().nullable(),
  }),
});

// API Response Schemas

// 1. Get Food by FDC ID
export const getFoodByIdResponse = z.object({
  fdc_id: z.number(),
  data_type: z.string(),
  description: z.string().nullable(),
});

// 2. Get Legacy Food by FDC ID
export const getLegacyFoodResponse = z.object({
  fdc_id: z.number(),
  ndb_number: z.number(),
}).nullable();

// 3. Get Food Portions
export const getFoodPortionsResponse = z.array(
  z.object({
    amount: z.number(),
    modifier: z.string().nullable(),
    gram_weight: z.number(),
  })
);

// 4. Get Nutrient Summary
export const getNutrientSummaryResponse = z.object({
  nutrientSummary: z.array(nutrientInfo),
  nutrientsPer100: z.object({
    protein: z.number(),
    kcal: z.number(),
  }),
});

// 5. Get Branded Food by FDC ID
export const getBrandedFoodResponse = z.object({
  fdc_id: z.number(),
}).merge(brandedFoodInfo).nullable();

// Composite Route (Complete Food Response)
export const getCompleteFoodResponse = z.object({
  fdc_id: z.number(),
  foodInfo: foodInfo.omit({ fdc_id: true }),
  brandedFoodInfo: brandedFoodInfo.nullable(),
  legacyFoodInfo: legacyFoodInfo.omit({ fdc_id: true }).nullable(),
  nutritionInfo: getNutrientSummaryResponse,
  portionInfo: z.object({
    raw: getFoodPortionsResponse,
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
  orderBy: z.enum(["description", "data_type", "fdc_id"]).optional().default("description"),
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