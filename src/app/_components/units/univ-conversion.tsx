import { WMeasure, MeasureKind } from "recipebridge/pkg/recipebridge";
import { Amount } from "~/codec/codec";
import { Result, withFailure, withSuccess } from "~/misc/util";
import {
  ProductWithMappingsAndFoodOut,
  IngredientWithRecipesAndProductOut,
  unitMappignsFromProduct,
} from "~/schemas/combo";
import { UnitMapping } from "~/schemas/unitmapping";
import { NutrientsPer100 } from "~/schemas/usda";
import { wasm } from "~/wasmContext";
import { SectionIngredientOut } from "~/schemas/recipe";
import React from "react";

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
 * Calculates nutrients based on amount, mappings, and product
 */
export const calculateNutrients = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
  product: ProductWithMappingsAndFoodOut[] | undefined,
): Result<{
  gram: WMeasure;
  nutrient: NutrientsPer100;
}> => {
  // Convert the amount to weight in grams
  const grams = safeConvertAmount(w, amount, mappings, "weight");
  if (!grams.success) {
    return grams;
  }
  const gramsValue = grams.value;

  // Try to find nutrient information from products
  const firstNutrient = product
    ?.flatMap((p) => getProductNutrients(p))
    .filter((x) => x !== undefined)
    .pop();

  if (!firstNutrient) {
    return withFailure(`Product(s) have no nutrients`);
  }

  // Scale nutrients based on weight
  const scaledNutrient = scaleNutrientsByWeight(
    firstNutrient,
    gramsValue.value,
  );

  return withSuccess({
    gram: gramsValue,
    nutrient: scaledNutrient,
  });
};

/**
 * Extracts gram and nutrient results from calculateNutrients result
 * (Previously known as getGramAndNutrient)
 */
export const getGramAndNutrient = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
  product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WMeasure>; nutrient: Result<NutrientsPer100> } => {
  const result = calculateNutrients(w, amount, mappings, product);

  if (!result.success) {
    return {
      gram: withFailure(result.error),
      nutrient: withFailure(result.error),
    };
  }

  return {
    gram: withSuccess(result.value.gram),
    nutrient: withSuccess(result.value.nutrient),
  };
};

/**
 * Formats nutrient values as a string or JSX element
 */
export const formatNutrients = (
  nutrients: NutrientsPer100,
  asJSX = false,
): string | React.ReactElement => {
  if (asJSX) {
    return (
      <div className="space-y-1 text-sm">
        <div>
          <span className="font-medium">Calories:</span>{" "}
          {nutrients.kcal.toFixed(1)} kcal
        </div>
        <div>
          <span className="font-medium">Protein:</span>{" "}
          {nutrients.protein.toFixed(1)}g
        </div>
      </div>
    );
  }
  return `${nutrients.kcal.toFixed(1)} kcal, ${nutrients.protein.toFixed(1)}g protein`;
};

/**
 * Creates a JSX element for displaying nutrients (maintains backward compatibility)
 */
export const renderNutrients = (
  nutrients: NutrientsPer100,
): React.ReactElement => {
  return formatNutrients(nutrients, true) as React.ReactElement;
};

/**
 * Sums multiple nutrient objects
 */
export const sumNutrients = (nutrients: NutrientsPer100[]): NutrientsPer100 => {
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
export const getIngredientMeasures = (
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
  const mappings = product?.flatMap((p) => unitMappignsFromProduct(p)) || [];
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
  const missing = [];
  const nutrients: NutrientsPer100[] = [];

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
        missing.push(`price-${ingName}`);
      }

      if (gram.success) {
        grams.push(gram.value);
      } else {
        missing.push(`gram-${ingName}`);
      }

      if (nutrient.success) {
        nutrients.push(nutrient.value);
      } else {
        missing.push(`nutrient-${ingName}`);
      }
    } catch (e) {
      console.log(`Error calculating measures for ${ingName}`, e);
      missing.push(ingName);
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
    missing,
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
  return w
    ? ingredients.map((i) => ({
        ...i,
        priceInfo: ingMap && getIngredientMeasures(w, i, ingMap),
      }))
    : [];
};
