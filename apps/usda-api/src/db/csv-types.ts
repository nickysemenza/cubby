// TypeScript interfaces for USDA CSV file structures
// These types match the exact column names in the CSV files

export interface MeasureUnitCsvRecord extends Record<string, unknown> {
  id: string;
  name: string;
}

export interface NutrientCsvRecord extends Record<string, unknown> {
  id: string;
  name: string;
  unit_name: string;
  nutrient_nbr: string;
  rank: string;
}

export interface FoodCsvRecord extends Record<string, unknown> {
  fdc_id: string;
  data_type: string;
  description: string;
  food_category_id: string;
  publication_date: string;
}

export interface SrLegacyFoodCsvRecord extends Record<string, unknown> {
  fdc_id: string;
  NDB_number: string;
}

export interface BrandedFoodCsvRecord extends Record<string, unknown> {
  fdc_id: string;
  brand_owner: string;
  brand_name: string;
  subbrand_name: string;
  gtin_upc: string;
  ingredients: string;
  not_a_significant_source_of: string;
  serving_size: string;
  serving_size_unit: string;
  household_serving_fulltext: string;
  branded_food_category: string;
  data_source: string;
  package_weight: string;
  modified_date: string;
  available_date: string;
  market_country: string;
  discontinued_date: string;
  preparation_state_code: string;
  trade_channel: string;
  short_description: string;
  material_code: string;
}

export interface FoodNutrientCsvRecord extends Record<string, unknown> {
  id: string;
  fdc_id: string;
  nutrient_id: string;
  amount: string;
  data_points: string;
  derivation_id: string;
  min: string;
  max: string;
  median: string;
  loq: string;
  footnote: string;
  min_year_acquired: string;
  percent_daily_value: string;
}

export interface FoodPortionCsvRecord extends Record<string, unknown> {
  id: string;
  fdc_id: string;
  seq_num: string;
  amount: string;
  measure_unit_id: string;
  portion_description: string;
  modifier: string;
  gram_weight: string;
  data_points: string;
  footnote: string;
  min_year_acquired: string;
}
