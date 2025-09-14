import { z } from 'zod';

export const upc = z.string().min(12).max(14).describe('12 digit UPC code');
// NDB (Nutrient Data Bank) number - USDA-specific identifier
export const ndb = z.number().max(99999).min(1000).describe('NDB number');

// select distinct unit_name from nutrient;
export const nutrient_unit_name = z.enum([
  'MG_ATE',
  'kJ',
  'MCG_RE',
  'KCAL',
  'SP_GR',
  'PH',
  'UG',
  'MG_GAE',
  'UMOL_TE',
  'G',
  'MG',
  'IU',
]);

// select distinct data_type from usda_food;
export const dataTypeEnum = z.enum([
  'agricultural_acquisition',
  'branded_food',
  'experimental_food',
  'foundation_food',
  'market_acquisition',
  'sample_food',
  'sr_legacy_food',
  'sub_sample_food',
  'survey_fndds_food',
]);
export type DataType = z.infer<typeof dataTypeEnum>;

//select distinct serving_size_unit from branded_food;
export const branded_food_serving_size_unit = z.enum([
  'g',
  'GM',
  'GRM',
  'IU',
  'MC',
  'MG',
  'ml',
  'MLT',
]);
export type BrandedFoodServingSizeUnit = z.infer<
  typeof branded_food_serving_size_unit
>;

export const nutrientSummary = z
  .object({
    amount: z.number(),
    name: z.string(),
    unit: nutrient_unit_name,
  })
  .describe('usda food_nutrient and nutrient tables');
export const foodInfo = z
  .object({
    data_type: dataTypeEnum,
    description: z.string(),
  })
  .describe('usda food table');

const nutrientsPer100 = z.object({
  protein: z.number(),
  kcal: z.number(),
});
export type NutrientsPer100 = z.infer<typeof nutrientsPer100>;
export const brandedFoodInfo = z.object({
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  branded_food_category: z.string().nullable(),
  gtin_upc: upc,
  ingredients: z.string().nullable(),
  serving: z.object({
    serving_size: z.number().nullable(),
    serving_size_unit: z.string().nullable(),
    household_serving_fulltext: z.string().nullable(),
  }),
});

export const nutritionInfo = z.object({
  nutrientSummary: z.array(nutrientSummary),
  nutrientsPer100: nutrientsPer100,
});

export type NutritionInfo = z.infer<typeof nutritionInfo>;

export const foodPortion = z.object({
  amount: z.number(),
  modifier: z.string().nullable(),
  gram_weight: z.number(),
});

export const legacyFoodInfo = z.object({
  ndb_number: ndb,
});
export type LegacyFoodInfo = z.infer<typeof legacyFoodInfo>;

export const brandedFoodRaw = z.object({
  fdc_id: z.number(),
  serving_size: z.number().nullable(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
});
export type BrandedFoodRaw = z.infer<typeof brandedFoodRaw>;
export const foodSummary = z.object({
  fdc_id: z.number(),
  brandedFoodInfo: brandedFoodInfo.nullable(),
  foodInfo,
  legacyFoodInfo: legacyFoodInfo.nullable(),
  nutritionInfo,
  portionInfoRaw: z.array(foodPortion),
});
export type BrandedFoodInfo = z.infer<typeof brandedFoodInfo>;
export type NutrientSummary = z.infer<typeof nutrientSummary>;
export type FoodInfo = z.infer<typeof foodInfo>;
export type FoodSummary = z.infer<typeof foodSummary>;
export type FoodPortion = z.infer<typeof foodPortion>;

export const foodLookupParam = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upc'), gtin_upc: upc }),
  z.object({ kind: z.literal('ndb'), ndb_number: ndb }),
]);

export type FoodLookupParam = z.infer<typeof foodLookupParam>;
