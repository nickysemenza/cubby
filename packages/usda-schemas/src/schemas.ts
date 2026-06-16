import { z } from "zod";

export const upc = z
  .string()
  .min(12)
  .max(14)
  .describe("UPC-A (12), EAN-13 (13), or GTIN-14 (14) barcode");
// NDB (Nutrient Data Bank) number - USDA-specific identifier
export const ndb = z.number().max(99999).min(1000).describe("USDA NDB number");

// FDC ID — FoodData Central's universal food identifier. Every USDA food
// (branded, foundation, sr_legacy, survey) has exactly one positive-integer
// fdc_id, so it's the canonical, type-agnostic key for linking a product to any
// food — unlike `upc` (branded only) or `ndb` (sr_legacy only). Use this schema
// everywhere an fdc_id is validated.
export const fdcId = z
  .number()
  .int()
  .positive()
  .describe("USDA FoodData Central id (universal food primary key)");
export type FdcId = z.infer<typeof fdcId>;

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

// select distinct data_type from usda_food;
export const dataTypeEnum = z.enum([
  "agricultural_acquisition",
  "branded_food",
  "experimental_food",
  "foundation_food",
  "market_acquisition",
  "sample_food",
  "sr_legacy_food",
  "sub_sample_food",
  "survey_fndds_food",
]);
export type DataType = z.infer<typeof dataTypeEnum>;

// Human-friendly labels for the USDA data_type enum. Anything not listed falls
// back to a title-cased version of the raw value.
const DATA_TYPE_LABELS: Partial<Record<DataType, string>> = {
  branded_food: "Branded",
  sr_legacy_food: "SR Legacy",
  foundation_food: "Foundation",
  survey_fndds_food: "Survey",
  experimental_food: "Experimental",
  agricultural_acquisition: "Agricultural",
  market_acquisition: "Market",
  sample_food: "Sample",
  sub_sample_food: "Sub-sample",
};

export function dataTypeLabel(dataType: DataType): string {
  return (
    DATA_TYPE_LABELS[dataType] ??
    dataType
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

// Preference order for ranking USDA search results, lower = surfaced first.
// This is EMPIRICAL: median nutrient count per food in the FDC dataset is
// SR Legacy ~85 > Survey ~65 > Foundation ~30 > Branded ~14, so richer
// (more-complete) reference foods out-rank sparse branded label data. The five
// sampling/research types carry ~0 nutrients and sort last (and are normally
// hidden by foodsOnly). Drives SQL ordering in usda-api (dataTypePriorityCase).
export const DATA_TYPE_PRIORITY: Record<DataType, number> = {
  sr_legacy_food: 0,
  survey_fndds_food: 1,
  foundation_food: 2,
  branded_food: 3,
  agricultural_acquisition: 4,
  market_acquisition: 4,
  sample_food: 4,
  sub_sample_food: 4,
  experimental_food: 4,
};

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
export type BrandedFoodServingSizeUnit = z.infer<
  typeof branded_food_serving_size_unit
>;

export const nutrientSummary = z
  .object({
    amount: z.number(),
    name: z.string(),
    unit: nutrient_unit_name,
  })
  .describe("usda food_nutrient and nutrient tables");
export const foodInfo = z
  .object({
    data_type: dataTypeEnum,
    description: z.string(),
  })
  .describe("usda food table");

// Generic nutrients record - maps nutrient codes (e.g., "203" for protein) to amounts
// Keys are USDA nutrient_nbr values (e.g., "203" for protein, "208" for kcal)
const nutrientsPer100 = z.record(z.string(), z.number());
export { nutrientsPer100 };
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
  fdc_id: fdcId,
  serving_size: z.number().nullable(),
  serving_size_unit: z.string().nullable(),
  household_serving_fulltext: z.string().nullable(),
});
export type BrandedFoodRaw = z.infer<typeof brandedFoodRaw>;
export const foodSummary = z.object({
  fdc_id: fdcId,
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

export const foodLookupParam = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upc"), gtin_upc: upc }),
  z.object({ kind: z.literal("ndb"), ndb_number: ndb }),
  // The explicit, type-agnostic link — reaches Foundation/Survey foods that have
  // neither a UPC nor an NDB number. See `fdcId`.
  z.object({ kind: z.literal("fdc"), fdc_id: fdcId }),
]);

export type FoodLookupParam = z.infer<typeof foodLookupParam>;
