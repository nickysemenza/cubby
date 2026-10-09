import { BARCODE_RE } from "@cubby/shared/upc";
import { TIER1_CODES } from "../../nutrient-codes";
import type { FoodPortion } from "../../schemas";

const DATA_TYPE_ALIASES = new Map([
  // USDA ships the market acquisition data type misspelled.
  ["market_acquistion", "market_acquisition"],
]);

export const normalizeDataType = (dataType: string): string =>
  DATA_TYPE_ALIASES.get(dataType) ?? dataType;

/**
 * FDC writes publication_date as ISO `YYYY-MM-DD` except for a few rows in
 * `M/D/YYYY`; both become ISO so revisions order by date, not by string.
 */
export function isoPublicationDate(
  value: string,
  fdcId: number,
): string | null {
  if (value === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (us) {
    const [, month = "", day = "", year = ""] = us;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  throw new Error(`fdc_id ${fdcId}: unreadable publication_date "${value}"`);
}

/**
 * The published gtin_upc as `brandedFoodInfo.gtin_upc`: FDC strips leading
 * zeros from some UPC-As, so 1-11 digits pad back to 12. A value that still is
 * not barcode-shaped (hyphenated, 15+ digits) has no representable barcode.
 */
export function publishedGtinUpc(value: string): string | null {
  const padded = /^\d{1,11}$/u.test(value) ? value.padStart(12, "0") : value;
  return BARCODE_RE.test(padded) ? padded : null;
}

export interface StagedFood {
  fdc_id: number;
  data_type: string;
  description: string;
  gtin_upc: string | null;
  brand_owner: string | null;
  brand_name: string | null;
  branded_food_category: string | null;
  ingredients: string | null;
  serving_size: number | null;
  serving_size_unit: string | null;
  household_serving_fulltext: string | null;
  ndb_number: number | null;
}

export interface StagedNutrient {
  amount: number;
  name: string;
  unit: string;
  nutrient_nbr: string | null;
}

const TIER1 = new Set(TIER1_CODES);

/**
 * The `FoodSummary` the old D1 importer and edge bundles produced, before
 * schema validation (units and data types are checked by the shard line).
 */
export function assembleFood(
  food: StagedFood,
  nutrients: readonly StagedNutrient[],
  portions: readonly FoodPortion[],
) {
  return {
    fdc_id: food.fdc_id,
    foodInfo: { data_type: food.data_type, description: food.description },
    brandedFoodInfo: food.gtin_upc
      ? {
          brand_owner: food.brand_owner,
          brand_name: food.brand_name,
          branded_food_category: food.branded_food_category,
          gtin_upc: food.gtin_upc,
          ingredients: food.ingredients,
          serving: {
            serving_size: food.serving_size,
            serving_size_unit: food.serving_size_unit,
            household_serving_fulltext: food.household_serving_fulltext,
          },
        }
      : null,
    legacyFoodInfo: food.ndb_number ? { ndb_number: food.ndb_number } : null,
    nutritionInfo: {
      nutrientSummary: nutrients.map(({ amount, name, unit }) => ({
        amount,
        name,
        unit,
      })),
      nutrientsPer100: Object.fromEntries(
        nutrients.flatMap((nutrient) =>
          nutrient.nutrient_nbr && TIER1.has(nutrient.nutrient_nbr)
            ? [[nutrient.nutrient_nbr, nutrient.amount]]
            : [],
        ),
      ),
    },
    portionInfoRaw: portions,
  };
}
