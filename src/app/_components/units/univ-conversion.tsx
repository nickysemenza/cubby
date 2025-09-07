import { WMeasure, MeasureKind } from "recipebridge/pkg/recipebridge";
import { Amount } from "~/codec/codec";
import { Result, withFailure, withSuccess } from "~/misc/result-types";
import {
  ProductWithMappingsAndFoodOut,
  IngredientWithRecipesAndProductOut,
  unitMappingsFromProduct,
} from "~/schemas/combo";
import { UnitMapping } from "~/schemas/unitmapping";
import { NutrientsPer100 } from "~/schemas/usda";
import { wasm } from "~/hooks/useWasm";
import { SectionIngredientOut } from "~/schemas/recipe";

/**
 * Extracts nutrient information from a product
 */
export const getProductNutrients = (
  product: ProductWithMappingsAndFoodOut,
): NutrientsPer100 | undefined => {
  return product.food?.nutritionInfo?.nutrientsPer100;
};

/**
 * Creates a zero-value nutrient object
 */
export const createEmptyNutrients = (): NutrientsPer100 => ({
  protein: 0,
  kcal: 0,
});

/**
 * Scales nutrient values based on weight
 */
export const scaleNutrientsByWeight = (
  nutrients: NutrientsPer100,
  weightInGrams: number,
): NutrientsPer100 => {
  const scaleFactor = weightInGrams / 100;
  return {
    protein: nutrients.protein * scaleFactor,
    kcal: nutrients.kcal * scaleFactor,
  };
};

/**
 * Generic function to safely convert amounts using wasm
 */
export const safeConvertAmount = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
  kind: MeasureKind,
): Result<WMeasure> => {
  try {
    const result = w.conv_measure_to_kind(mappings, kind, amount);
    return withSuccess(result);
  } catch (e) {
    return withFailure(`Error converting to ${kind}: ${e}`);
  }
};

/**
 * Converts an amount to a price measure
 */
export const convertAmountToPrice = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
): Result<WMeasure> => {
  return safeConvertAmount(w, amount, mappings, "money");
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
    ?.flatMap((p) => getProductNutrients(p))
    .filter((x) => x !== undefined)
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
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
  product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WMeasure>; nutrient: Result<NutrientsPer100> } => {
  // Convert the amount to weight in grams - this should work independently
  const gramResult = safeConvertAmount(w, amount, mappings, "weight");

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
 * Sums multiple nutrient objects
 */
const sumNutrients = (nutrients: NutrientsPer100[]): NutrientsPer100 => {
  return nutrients.reduce(
    (acc, curr) => ({
      protein: acc.protein + (curr.protein || 0),
      kcal: acc.kcal + (curr.kcal || 0),
    }),
    createEmptyNutrients(),
  );
};

/**
 * Gets price, weight, and nutrient information for an ingredient
 */
const getIngredientMeasures = (
  w: wasm,
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientWithRecipesAndProductOut>,
): {
  price: Result<WMeasure>;
  gram: Result<WMeasure>;
  nutrient: Result<NutrientsPer100>;
} => {
  // Handle based on ingredient type (discriminated union)
  const id =
    ingredient.type === "ingredient" ? ingredient.ingredient.id : undefined;
  const entry = id ? ingMap[id] : undefined;
  const product = entry?.product;
  const mappings = product?.flatMap((p) => unitMappingsFromProduct(p)) || [];
  const firstAmount = ingredient.amounts[0];

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: withFailure(error),
      gram: withFailure(error),
      nutrient: withFailure(error),
    };
  }

  const price = convertAmountToPrice(w, firstAmount, mappings);
  const { gram, nutrient } = getGramAndNutrient(
    w,
    firstAmount,
    mappings,
    product,
  );

  return { price, gram, nutrient };
};

/**
 * Calculates price, weight, and nutrient information for a list of ingredients
 */
export const calculateTotals = (
  w: wasm,
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientWithRecipesAndProductOut>,
  getIngredientName: (ingredient: SectionIngredientOut) => string,
) => {
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
      const { price, gram, nutrient } = getIngredientMeasures(
        w,
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
    protein: totalNutrients.protein,
    kcal: totalNutrients.kcal,
    weight: totalWeight,
    totalIngredients: ingredients.length,
    missingByType,
  };
};

/**
 * Creates a wrapper for tracking ingredient data with price/nutrient info
 */
export const createIngredientData = (
  w: wasm,
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientWithRecipesAndProductOut> | undefined,
) => {
  return ingredients.map((i) => ({
    ...i,
    priceInfo: ingMap && getIngredientMeasures(w, i, ingMap),
  }));
};
