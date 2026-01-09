import type { AmountKind, WAmount } from "@recipehub/recipebridge";
import {
  getNutrientUnitString,
  type NutrientKey,
  type NutrientsPer100,
  TIER1_NUTRIENTS,
} from "@recipehub/usda-schemas";
import type { Amount } from "~/codec/codec";
import { isMiscProduct } from "~/lib/constants";
import { wasm } from "~/lib/wasm";
import { type Result, withFailure, withSuccess } from "~/misc/result-types";
import type { SectionIngredientOut } from "~/schemas/recipe";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import type { UnitMapping } from "~/schemas/unitmapping";
import type {
  IngredientWithFoodOut,
  ProductWithMappingsAndFoodOut,
} from "~/server/services/ingredient.service";

/**
 * Get nutrient target unit strings for WASM batch conversion
 * Format: "g protein", "mg sodium", etc.
 * NOTE: kcal is excluded - it must use conv_amount_to_kind("calories") instead
 * because WASM treats Unit::KCal differently from Unit::Other("kcal")
 */
const getNutrientTargets = (): { key: NutrientKey; target: string }[] => {
  return (Object.keys(TIER1_NUTRIENTS) as NutrientKey[])
    .filter((key) => key !== "kcal") // kcal handled separately via conv_amount_to_kind
    .map((key) => ({
      key,
      target: getNutrientUnitString(key),
    }));
};

/**
 * Convert an amount directly to all nutrients via WASM graph traversal
 * This replaces the old TypeScript-based scaling approach
 *
 */
export const convertAmountToNutrients = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<NutrientsPer100> => {
  try {
    const targets = getNutrientTargets();
    const targetStrings = targets.map((t) => t.target);

    // Batch convert to all nutrient targets in single WASM call
    const results = wasm.conv_amount_to_nutrients(
      mappings,
      targetStrings,
      amount,
    ) as Record<string, WAmount | null>;

    // Map results back to nutrient codes
    const nutrients: NutrientsPer100 = {};
    for (const { key, target } of targets) {
      const converted = results[target];
      if (converted) {
        const code = TIER1_NUTRIENTS[key].code;
        nutrients[code] = converted.value;
      }
    }

    // Handle kcal separately using conv_amount_to_kind("calories")
    // This is needed because WASM treats Unit::KCal differently from Unit::Other("kcal")
    // MeasureKind::Nutrient("kcal") creates Unit::Other("kcal"), but mappings use Unit::KCal
    try {
      const kcalResult = wasm.conv_amount_to_kind(mappings, "calories", amount);
      if (kcalResult) {
        const kcalCode = TIER1_NUTRIENTS.kcal.code;
        nutrients[kcalCode] = kcalResult.value;
      }
    } catch {
      // kcal conversion failed - this is fine, just means no path exists
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
 *
 */
export const createEmptyNutrients = (): NutrientsPer100 =>
  ({}) as NutrientsPer100;

/**
 * Generic function to safely convert amounts using wasm
 */
export const safeConvertAmount = (
  amount: Amount,
  mappings: UnitMapping[],
  kind: AmountKind,
): Result<WAmount> => {
  try {
    const result = wasm.conv_amount_to_kind(mappings, kind, amount);
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
): Result<WAmount> => {
  return safeConvertAmount(amount, mappings, "money");
};

/**
 * Extracts gram and nutrient results separately using WASM for both conversions.
 * Weight and nutrient conversions are now independent - both use the graph.
 *
 */
export const getGramAndNutrient = (
  amount: Amount,
  mappings: UnitMapping[],
  _product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WAmount>; nutrient: Result<NutrientsPer100> } => {
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
  price: Result<WAmount>;
  gram: Result<WAmount>;
  nutrient: Result<NutrientsPer100>;
}> => {
  // Handle based on ingredient type (discriminated union)
  const id =
    ingredient.type === "ingredient" ? ingredient.ingredient.id : undefined;
  const entry = id ? ingMap[id] : undefined;
  const product = entry?.product;

  // Filter out misc products for pricing (they're just placeholders)
  const productsForPricing = (product ?? []).filter(
    (p) => !isMiscProduct(p.name),
  );

  // Get all mappings from non-misc products for pricing
  const pricingMappingArrays = await Promise.all(
    productsForPricing.map((p) => getAllUnitMappingsFromProduct(p)),
  );
  const pricingMappings = pricingMappingArrays.flat();

  // Use all products (including misc) for weight and nutrient conversions
  const allMappingArrays = await Promise.all(
    (product ?? []).map((p) => getAllUnitMappingsFromProduct(p)),
  );
  const allMappings = allMappingArrays.flat();

  const firstAmount = ingredient.amounts[0];

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: withFailure(error),
      gram: withFailure(error),
      nutrient: withFailure(error),
    };
  }

  // Use pricing mappings (excluding misc) for price conversion
  const price = convertAmountToPrice(firstAmount, pricingMappings);

  // Use all mappings (including misc) for weight and nutrient conversions
  const { gram, nutrient } = getGramAndNutrient(
    firstAmount,
    allMappings,
    product,
  );

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
  const prices: WAmount[] = [];
  const grams: WAmount[] = [];
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

type IngredientPriceInfo = {
  price: Result<WAmount>;
  gram: Result<WAmount>;
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
