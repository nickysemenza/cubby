import { UnitMapping } from "./unitmapping";
import {
  FoodSummary,
  branded_food_serving_size_unit,
  type BrandedFoodServingSizeUnit,
} from "@recipehub/usda-schemas";
import { type wasm } from "~/hooks/useWasm";

/**
 * Normalizes USDA branded food serving size units to standard units
 */
const normalizeBrandedFoodServingSizeUnit = (
  unit: BrandedFoodServingSizeUnit,
): string => {
  switch (unit) {
    case "GM":
    case "GRM":
      return "g";
    case "MC":
    case "MLT":
      return "ml";
    case "g":
    case "IU":
    case "MG":
    case "ml":
      return unit;
    default:
      // Use assertNever for exhaustive checking
      const _exhaustive: never = unit;
      return _exhaustive;
  }
};

/**
 * Creates a unit mapping from branded food serving size info using WASM parsing
 */
const createServingMapping = (
  w: wasm,
  fdc_id: number,
  serving: {
    serving_size: number | null;
    serving_size_unit: string | null;
    household_serving_fulltext: string | null;
  },
): UnitMapping | undefined => {
  if (
    serving.serving_size === null ||
    serving.serving_size_unit === null ||
    serving.household_serving_fulltext === null
  ) {
    return undefined;
  }

  try {
    const p = w.parse_ingredient(serving.household_serving_fulltext);
    const b = p.amounts.pop();
    if (b === undefined) {
      console.log(`branded food ${fdc_id} missing amounts`);
      return undefined;
    }
    const servingSizeUnit = branded_food_serving_size_unit.parse(
      serving.serving_size_unit,
    );
    return {
      a: {
        value: serving.serving_size,
        unit: normalizeBrandedFoodServingSizeUnit(servingSizeUnit),
      },
      b,
      source: `USDA FDC serving`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    };
  } catch (error) {
    console.log(`branded food ${fdc_id} serving parsing failed:`, error);
    return undefined;
  }
};

/**
 * Converts a raw food portion to a unit mapping
 */
export const unitMappingFromPortionInfo = (
  portionInfo: {
    amount: number;
    modifier: string | null;
    gram_weight: number;
  },
  fdc_id: number,
): UnitMapping => {
  return {
    a: {
      value: portionInfo.amount,
      unit: portionInfo.modifier ?? "portion",
    },
    b: {
      value: portionInfo.gram_weight,
      unit: "g",
    },
    source: `USDA portion`,
    sourceMetadata: { type: "food" as const, fdcId: fdc_id },
  };
};

/**
 * Creates unit mappings from nutrition data (e.g., 100g → 374kcal)
 */
const unitMappingsFromNutrition = (food: FoodSummary): UnitMapping[] => {
  const nutrition = food.nutritionInfo?.nutrientsPer100;
  if (!nutrition) return [];
  const mappings: UnitMapping[] = [];
  const { fdc_id } = food;

  // Create calorie mapping: 100g → X kcal
  if (nutrition.kcal > 0) {
    mappings.push({
      a: { value: 100, unit: "g" },
      b: { value: nutrition.kcal, unit: "kcal" },
      source: `USDA nutrition`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    });
  }

  // Create protein mapping: 100g → X g protein
  if (nutrition.protein > 0) {
    mappings.push({
      a: { value: 100, unit: "g" },
      b: { value: nutrition.protein, unit: "g protein" },
      source: `USDA nutrition`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    });
  }

  return mappings;
};

export const unitMappingsFromFood = (
  food: FoodSummary,
  w: wasm,
): UnitMapping[] => {
  const { fdc_id, portionInfoRaw, brandedFoodInfo } = food;

  // Get serving size mapping from branded food info with WASM parsing
  const servingMapping = brandedFoodInfo?.serving
    ? createServingMapping(w, fdc_id, brandedFoodInfo.serving)
    : undefined;

  return [
    // Parse raw portions to unit mappings
    ...portionInfoRaw.map((p) => unitMappingFromPortionInfo(p, fdc_id)),
    ...(servingMapping ? [servingMapping] : []),
    ...unitMappingsFromNutrition(food),
  ];
};

/**
 * Gets all unit mappings from a product, including both direct unit mappings
 * and mappings derived from food data
 */
export const getAllUnitMappingsFromProduct = (
  product: {
    unitMappings: UnitMapping[];
    food?: FoodSummary | null;
  },
  w: wasm,
): UnitMapping[] => {
  const foodMappings = product.food
    ? unitMappingsFromFood(product.food, w)
    : [];
  return [...product.unitMappings, ...foodMappings];
};
