import { z } from "zod";
import { upc } from "./util";

// select distinct unit_name from nutrient;
export const nutrient_unit_name = z.enum([
  "MG_ATE",
  "kJ",
  "MCG_RE",
  "KCAL",
  "SP_GR",
  "PH",
  "UG",
  "MG_GAE",
  "UMOL_TE",
  "G",
  "MG",
  "IU",
]);

//select distinct serving_size_unit from branded_food;
export const branded_food_serving_size_unit = z.enum([
  "g",
  "GM",
  "GRM",
  "IU",
  "MC",
  "MG",
  "ml",
  "MLT",
]);
const nutrientSummary = z.object({
  amount: z.number(),
  name: z.string(),
  unit: nutrient_unit_name,
});
const foodInfo = z.object({
  data_type: z.string(),
  description: z.string(),
});

const BrandedFoodServingInfo = z.object({
  serving_size: z.number().optional(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
});
export const brandedFoodSummary = z.object({
  fdc_id: z.number(),
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  branded_food_category: z.string().nullable(),
  gtin_upc: upc,
  ingredients: z.string().nullable(),
  serving: BrandedFoodServingInfo,
  foodInfo: foodInfo.nullable(),
  nutrientSummary: z.array(nutrientSummary),
});

export type NutrientSummary = z.infer<typeof nutrientSummary>;
export type FoodInfo = z.infer<typeof foodInfo>;
export type BrandedFoodSummary = z.infer<typeof brandedFoodSummary>;
