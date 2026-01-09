import {
  type BrandedFoodServingSizeUnit,
  branded_food_serving_size_unit,
  type FoodSummary,
  getNutrientKey,
  getNutrientUnitString,
  isTier1Nutrient,
  type NutrientKey,
} from "@recipehub/usda-schemas";
import { wasm } from "~/lib/wasm";
import type { UnitMapping } from "./unitmapping";

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
    default: {
      // Use assertNever for exhaustive checking
      const _exhaustive: never = unit;
      return _exhaustive;
    }
  }
};

/**
 * Creates a unit mapping from branded food serving size info using WASM parsing
 */
const createServingMapping = (
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
    const p = wasm.parse_ingredient(serving.household_serving_fulltext);
    const b = p.amounts.pop();
    if (b === undefined) {
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
  } catch {
    return undefined;
  }
};

/**
 * Converts a raw food portion to a unit mapping
 */
const unitMappingFromPortionInfo = (
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
 * Creates unit mappings from nutrition data (e.g., 100g → 374kcal, 100g → 15g protein)
 * Generates mappings for all tier 1 nutrients from the generic nutrientsPer100 record.
 */
const unitMappingsFromNutrition = (food: FoodSummary): UnitMapping[] => {
  const nutrients = food.nutritionInfo?.nutrientsPer100;
  if (!nutrients) return [];
  const { fdc_id } = food;

  return Object.entries(nutrients)
    .filter(([code, amount]) => amount > 0 && isTier1Nutrient(code))
    .map(([code, amount]) => {
      const key = getNutrientKey(code) as NutrientKey;
      const unitStr = getNutrientUnitString(key);
      return {
        a: { value: 100, unit: "g" },
        b: { value: amount, unit: unitStr },
        // e.g., "g protein", "kcal", "mg sodium", "ug vitamin_b12"
        source: `USDA nutrition`,
        sourceMetadata: { type: "food" as const, fdcId: fdc_id },
      };
    });
};

export const unitMappingsFromFood = (food: FoodSummary): UnitMapping[] => {
  const { fdc_id, portionInfoRaw, brandedFoodInfo } = food;

  // Get serving size mapping from branded food info with WASM parsing
  const servingMapping = brandedFoodInfo?.serving
    ? createServingMapping(fdc_id, brandedFoodInfo.serving)
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
export const getAllUnitMappingsFromProduct = (product: {
  unitMappings: UnitMapping[];
  food?: FoodSummary | null;
}): UnitMapping[] => {
  const foodMappings = product.food ? unitMappingsFromFood(product.food) : [];
  return [...product.unitMappings, ...foodMappings];
};

/**
 * Aggregates unit mappings from all products for an entity with multiple products
 * (e.g., an ingredient that has multiple linked products)
 */
export const getIngredientMappings = <
  T extends {
    product: Array<{ unitMappings: UnitMapping[]; food?: FoodSummary | null }>;
  },
>(
  entity: T,
): UnitMapping[] => {
  return entity.product.flatMap((p) => getAllUnitMappingsFromProduct(p));
};

/**
 * Averages unit mappings when multiple products provide conflicting mappings
 * for the same unit pair (e.g., "cup → g").
 *
 * Groups mappings by unit pair, then averages the conversion values.
 * Example: Product A "1 cup = 240g" + Product B "1 cup = 250g" → "1 cup = 245g"
 *
 * Note: Excludes misc products (they're opaque placeholders without real data)
 */
export const averageUnitMappings = (
  mappings: UnitMapping[],
  productNames?: string[],
): UnitMapping[] => {
  // Group by unit pair (a.unit -> b.unit)
  const grouped = new Map<string, UnitMapping[]>();

  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i];
    if (!mapping) continue;

    // Skip if this is from a misc product (check productNames if provided)
    const productName = productNames?.[i];
    if (productName?.startsWith("misc:")) continue;

    const key = `${mapping.a.unit}->${mapping.b.unit}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(mapping);
    } else {
      grouped.set(key, [mapping]);
    }
  }

  // Average each group
  const result: UnitMapping[] = [];
  for (const [, group] of grouped) {
    if (group.length === 0) continue;

    if (group.length === 1) {
      const single = group[0];
      if (single) result.push(single);
      continue;
    }

    // Calculate average conversion ratio
    const first = group[0];
    if (!first) continue;

    let sumRatio = 0;
    for (const mapping of group) {
      const ratio = (mapping.b.value / mapping.a.value) * first.a.value;
      sumRatio += ratio;
    }
    const avgBValue = sumRatio / group.length;

    result.push({
      a: first.a,
      b: {
        value: avgBValue,
        unit: first.b.unit,
      },
      source: `Averaged from ${group.length} products`,
      sourceMetadata: undefined,
    });
  }

  return result;
};
