import { WMeasure, MeasureKind } from "@recipehub/recipebridge";
import { Amount } from "~/codec/codec";
import { Result, withFailure, withSuccess } from "~/misc/result-types";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import {
  type IngredientWithFoodOut,
  type ProductWithMappingsAndFoodOut,
} from "~/server/services/ingredient.service";
import { UnitMapping } from "~/schemas/unitmapping";
import { type NutrientsPer100 } from "@recipehub/usda-schemas";
import { wasm } from "~/lib/wasm";
import { SectionIngredientOut } from "~/schemas/recipe";

// Re-export NutrientsPer100 type for consumers
export type { NutrientsPer100 } from "@recipehub/usda-schemas";

/**
 * Extracts nutrient information from a product
 */
export const getProductNutrients = (product: {
  food: { nutritionInfo: { nutrientsPer100: NutrientsPer100 } } | null;
}): NutrientsPer100 | undefined => {
  return product.food?.nutritionInfo?.nutrientsPer100;
};

/**
 * Creates an empty nutrients record
 */
export const createEmptyNutrients = (): NutrientsPer100 =>
  ({}) as NutrientsPer100;

/**
 * Scales nutrient values based on weight.
 * Nutrients are per 100g, so we scale by weightInGrams / 100.
 */
export const scaleNutrientsByWeight = (
  nutrients: NutrientsPer100,
  weightInGrams: number,
): NutrientsPer100 => {
  const scaleFactor = weightInGrams / 100;
  return Object.fromEntries(
    Object.entries(nutrients).map(([code, amount]) => [
      code,
      amount * scaleFactor,
    ]),
  );
};

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
 * Calculates nutrients based on weight in grams and product data
 */
export const calculateNutrients = (
  weightInGrams: number,
  product: ProductWithMappingsAndFoodOut[] | undefined,
): Result<NutrientsPer100> => {
  // Try to find nutrient information from products
  const firstNutrient = product
    ?.map((p) => getProductNutrients(p))
    .filter((x): x is NutrientsPer100 => x !== undefined)
    .pop();

  if (!firstNutrient) {
    return withFailure(`Product(s) have no nutrients`);
  }

  // Scale nutrients based on weight
  const scaledNutrient = scaleNutrientsByWeight(firstNutrient, weightInGrams);

  return withSuccess(scaledNutrient);
};

/**
 * Extracts gram and nutrient results separately
 * (Previously known as getGramAndNutrient)
 */
export const getGramAndNutrient = (
  amount: Amount,
  mappings: UnitMapping[],
  product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WMeasure>; nutrient: Result<NutrientsPer100> } => {
  // Convert the amount to weight in grams - this should work independently
  const gramResult = safeConvertAmount(amount, mappings, "weight");

  // Calculate nutrients if we have a successful weight conversion
  const nutrientResult: Result<NutrientsPer100> = gramResult.success
    ? calculateNutrients(gramResult.value.value, product)
    : withFailure<NutrientsPer100>(
        "Cannot calculate nutrients without weight conversion",
      );

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
