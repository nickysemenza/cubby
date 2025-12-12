import { WMeasure, MeasureKind } from "@recipehub/recipebridge";
import { Amount } from "~/codec/codec";
import { Result, withFailure, withSuccess } from "~/misc/result-types";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import {
  type IngredientWithFoodOut,
  type ProductWithMappingsAndFoodOut,
} from "~/server/services/ingredient.service";
import { UnitMapping } from "~/schemas/unitmapping";
import {
  type NutrientsPer100,
  TIER1_NUTRIENTS,
  type NutrientKey,
} from "@recipehub/usda-schemas";
import { wasm } from "~/lib/wasm";
import { SectionIngredientOut } from "~/schemas/recipe";

// Re-export NutrientsPer100 type for consumers
export type { NutrientsPer100 } from "@recipehub/usda-schemas";

/**
 * Get nutrient target unit strings for WASM batch conversion
 * Format: "g protein", "mg sodium", "kcal kcal", etc.
 */
const getNutrientTargets = (): { key: NutrientKey; target: string }[] => {
  return (
    Object.entries(TIER1_NUTRIENTS) as [
      NutrientKey,
      (typeof TIER1_NUTRIENTS)[NutrientKey],
    ][]
  ).map(([key, info]) => ({
    key,
    target: `${info.unit.toLowerCase()} ${key}`,
  }));
};

/**
 * Convert an amount directly to all nutrients via WASM graph traversal
 * This replaces the old TypeScript-based scaling approach
 */
export const convertAmountToNutrients = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<NutrientsPer100> => {
  try {
    const targets = getNutrientTargets();
    const targetStrings = targets.map((t) => t.target);

    // Batch convert to all nutrient targets in single WASM call
    const results = wasm.conv_measure_to_nutrients(
      mappings,
      targetStrings,
      amount,
    ) as Record<string, WMeasure | null>;

    // Map results back to nutrient codes
    const nutrients: NutrientsPer100 = {};
    for (const { key, target } of targets) {
      const converted = results[target];
      if (converted) {
        const code = TIER1_NUTRIENTS[key].code;
        nutrients[code] = converted.value;
      }
    }

    // Check if we got any nutrients
    if (Object.keys(nutrients).length === 0) {
      return withFailure("No nutrient conversions succeeded");
    }

    return withSuccess(nutrients);
  } catch (e) {
    return withFailure(`Error converting to nutrients: ${e}`);
  }
};

/**
 * Creates an empty nutrients record
 */
export const createEmptyNutrients = (): NutrientsPer100 =>
  ({}) as NutrientsPer100;

/**
 * Generic function to safely convert amounts using wasm
 */
export const safeConvertAmount = (
  amount: Amount,
  mappings: UnitMapping[],
  kind: MeasureKind,
): Result<WMeasure> => {
  try {
    const result = wasm.conv_measure_to_kind(mappings, kind, amount);
    return withSuccess(result);
  } catch (e) {
    return withFailure(`Error converting to ${kind}: ${e}`);
  }
};

/**
 * Converts an amount to a price measure
 */
export const convertAmountToPrice = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<WMeasure> => {
  return safeConvertAmount(amount, mappings, "money");
};

/**
 * Extracts gram and nutrient results separately using WASM for both conversions.
 * Weight and nutrient conversions are now independent - both use the graph.
 */
export const getGramAndNutrient = (
  amount: Amount,
  mappings: UnitMapping[],
  _product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WMeasure>; nutrient: Result<NutrientsPer100> } => {
  // Convert amount to weight via WASM graph
  const gramResult = safeConvertAmount(amount, mappings, "weight");

  // Convert amount to nutrients via WASM graph (independent of weight conversion)
  const nutrientResult = convertAmountToNutrients(amount, mappings);

  return {
    gram: gramResult,
    nutrient: nutrientResult,
  };
};

/**
 * Sums multiple nutrient records, combining all nutrient codes
 */
const sumNutrients = (nutrients: NutrientsPer100[]): NutrientsPer100 => {
  const result: NutrientsPer100 = {};
  for (const n of nutrients) {
    for (const [code, amount] of Object.entries(n)) {
      result[code] = (result[code] ?? 0) + (amount ?? 0);
    }
  }
  return result;
};

/**
 * Gets price, weight, and nutrient information for an ingredient
 */
const getIngredientMeasures = async (
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientWithFoodOut>,
): Promise<{
  price: Result<WMeasure>;
  gram: Result<WMeasure>;
  nutrient: Result<NutrientsPer100>;
}> => {
  // Handle based on ingredient type (discriminated union)
  const id =
    ingredient.type === "ingredient" ? ingredient.ingredient.id : undefined;
  const entry = id ? ingMap[id] : undefined;
  const product = entry?.product;
  const mappingArrays = await Promise.all(
    (product ?? []).map((p) => getAllUnitMappingsFromProduct(p)),
  );
  const mappings = mappingArrays.flat();
  const firstAmount = ingredient.amounts[0];

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: withFailure(error),
      gram: withFailure(error),
      nutrient: withFailure(error),
    };
  }

  const price = convertAmountToPrice(firstAmount, mappings);
  const { gram, nutrient } = getGramAndNutrient(firstAmount, mappings, product);

  return { price, gram, nutrient };
};

export type CalculateTotalsResult = {
  price: number;
  nutrients: NutrientsPer100;
  weight: number;
  totalIngredients: number;
  missingByType: {
    price: string[];
    weight: string[];
    nutrients: string[];
  };
};

/**
 * Calculates price, weight, and nutrient information for a list of ingredients
 */
export const calculateTotals = async (
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientWithFoodOut>,
  getIngredientName: (ingredient: SectionIngredientOut) => string,
): Promise<CalculateTotalsResult> => {
  const prices: WMeasure[] = [];
  const grams: WMeasure[] = [];
  const nutrients: NutrientsPer100[] = [];
  const missingByType = {
    price: [] as string[],
    weight: [] as string[],
    nutrients: [] as string[],
  };

  for (const ingredient of ingredients) {
    const ingName = getIngredientName(ingredient);
    try {
      const { price, gram, nutrient } = await getIngredientMeasures(
        ingredient,
        ingMap,
      );

      if (price.success) {
        prices.push(price.value);
      } else {
        missingByType.price.push(ingName);
      }

      if (gram.success) {
        grams.push(gram.value);
      } else {
        missingByType.weight.push(ingName);
      }

      if (nutrient.success) {
        nutrients.push(nutrient.value);
      } else {
        missingByType.nutrients.push(ingName);
      }
    } catch (e) {
      console.error(`Error calculating measures for ${ingName}`);
      console.error(e);
      // If there's a general error, add to all missing categories
      missingByType.price.push(ingName);
      missingByType.weight.push(ingName);
      missingByType.nutrients.push(ingName);
    }
  }

  // Calculate totals
  const totalPrice = prices.reduce((acc, curr) => acc + (curr.value || 0), 0);
  const totalWeight = grams.reduce((acc, curr) => acc + curr.value, 0);
  const totalNutrients = sumNutrients(nutrients);

  return {
    price: totalPrice,
    nutrients: totalNutrients,
    weight: totalWeight,
    totalIngredients: ingredients.length,
    missingByType,
  };
};

export type IngredientPriceInfo = {
  price: Result<WMeasure>;
  gram: Result<WMeasure>;
  nutrient: Result<NutrientsPer100>;
};

export type IngredientDataItem = SectionIngredientOut & {
  priceInfo: IngredientPriceInfo | undefined;
};

/**
 * Creates a wrapper for tracking ingredient data with price/nutrient info
 */
export const createIngredientData = async (
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientWithFoodOut> | undefined,
): Promise<IngredientDataItem[]> => {
  return Promise.all(
    ingredients.map(async (i) => ({
      ...i,
      priceInfo: ingMap ? await getIngredientMeasures(i, ingMap) : undefined,
    })),
  );
};
