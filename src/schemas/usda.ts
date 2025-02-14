import { z } from "zod";
import { upc } from "./util";
import { unitMappingBase } from "./unitmapping";

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
export const normalize_branded_food_serving_size_unit = (
  unit: z.infer<typeof branded_food_serving_size_unit>,
) => {
  switch (unit) {
    case "GM":
    case "GRM":
      return "g";
    case "MC":
    case "MLT":
      return "ml";
    default:
      return unit;
  }
};

const nutrientSummary = z
  .object({
    amount: z.number(),
    name: z.string(),
    unit: nutrient_unit_name,
  })
  .describe("usda food_nutrient and nutrient tables");
const foodInfo = z
  .object({
    data_type: z.string(),
    description: z.string(),
  })
  .describe("usda food table");

const nutrientsPer100 = z.object({
  protein: z.number(),
});
const BrandedFoodServingInfo = z.object({
  serving_size: z.number().optional(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
});

const brandedFoodInfo = z.object({
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  branded_food_category: z.string().nullable(),
  gtin_upc: upc,
  ingredients: z.string().nullable(),
  serving: BrandedFoodServingInfo,
  serving_as_amount: unitMappingBase.optional(),
});

const nutritionInfo = z.object({
  nutrientSummary: z.array(nutrientSummary),
  nutrientsPer100: nutrientsPer100,
});

export type NutritionInfo = z.infer<typeof nutritionInfo>;

export const brandedFoodSummary = z.object({
  fdc_id: z.number(),
  brandedFoodInfo: brandedFoodInfo,
  foodInfo: foodInfo.nullable(),
  nutritionInfo,
});

export type NutrientSummary = z.infer<typeof nutrientSummary>;
export type FoodInfo = z.infer<typeof foodInfo>;
export type BrandedFoodSummary = z.infer<typeof brandedFoodSummary>;
