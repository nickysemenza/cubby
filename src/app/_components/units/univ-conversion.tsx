import { WMeasure } from "recipebridge/pkg/recipebridge";
import { z } from "zod";
import { Amount } from "~/codec/codec";
import { Result, withFailure, withSuccess } from "~/misc/util";
import {
  ingredientWithRecipesAndProductOut,
  ProductWithMappingsAndFoodOut,
} from "~/schemas/combo";
import { UnitMapping } from "~/schemas/unitmapping";
import { NutrientsPer100 } from "~/schemas/usda";
import { wasm } from "~/wasmContext";

export const convertAmountToPrice = (
  w: wasm,
  amount: Amount,
  mappings: UnitMapping[],
): Result<WMeasure> => {
  let price: Result<WMeasure>;
  try {
    price = withSuccess(w.conv_measure_to_kind(mappings, "money", amount));
  } catch (e) {
    price = withFailure(String(e));
  }
  return price;
};

export const getGramAndNutrient = (
  w: wasm,
  firstAmount: Amount,
  mappings: UnitMapping[],
  product:
    | z.infer<typeof ingredientWithRecipesAndProductOut>["product"]
    | undefined,
): { gram: Result<WMeasure>; nutrient: Result<NutrientsPer100> } => {
  try {
    const gramsValue = w.conv_measure_to_kind(mappings, "weight", firstAmount);
    const firstNutrient = product
      ?.flatMap((p) => getProductNutrients(p))
      .filter((x) => x !== undefined)
      .pop();

    return {
      gram: withSuccess(gramsValue),
      nutrient: firstNutrient
        ? withSuccess({
            protein: (gramsValue.value / 100) * (firstNutrient.protein || 0),
            kcal: (gramsValue.value / 100) * (firstNutrient.kcal || 0),
          })
        : withFailure(`product(s) have no nutrients`),
    };
  } catch (e) {
    const error = "convert to weight: " + e;
    return {
      gram: withFailure(error),
      nutrient: withFailure(error),
    };
  }
};

const getProductNutrients = (
  product: ProductWithMappingsAndFoodOut,
): NutrientsPer100 | undefined => {
  return product.food?.nutritionInfo?.nutrientsPer100;
};
