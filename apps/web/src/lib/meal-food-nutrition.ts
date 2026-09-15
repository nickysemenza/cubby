import type { MealFoodNutrients } from "@cubby/schemas/meal";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import type { ProductWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { getNutrientUnitString } from "@cubby/usda-schemas";

import { labelNutrientsPer100 } from "./label-nutrition";
import { scaleTotals } from "./nutrition-estimates";
import { sourceNutritionEstimate } from "./nutrition-format";
import { safeConvertAmount } from "./recipe-costing";
import { getAllUnitMappingsFromProduct } from "./unit-mapping-utils";

export const manualFoodTotals = (
  nutrients: MealFoodNutrients,
): NutritionTotals => ({
  cost: { status: "unavailable", reason: "no_data" },
  nutrition: buildNutrition((key) => {
    const value = nutrients[key];
    return value == null
      ? { status: "unavailable", reason: "no_data" }
      : {
          status: "complete",
          lower: value,
          upper: null,
          coverage: { covered: 1, total: 1 },
        };
  }),
});

export function productFoodTotals(
  product: ProductWithMappingsAndFoodOut,
  grams: number,
): NutritionTotals {
  const mappings = getAllUnitMappingsFromProduct(product);
  const cost = safeConvertAmount({ value: 100, unit: "g" }, mappings, "money");
  const nutrition = product.labelNutrition
    ? sourceNutritionEstimate(labelNutrientsPer100(product.labelNutrition))
    : buildNutrition((key) => {
        const result = safeConvertAmount(
          { value: 100, unit: "g" },
          mappings,
          key === "kcal"
            ? "calories"
            : `nutrient:${getNutrientUnitString(key)}`,
        );
        return result.isOk()
          ? {
              status: "complete",
              lower: result.value.value,
              upper: null,
              coverage: { covered: 1, total: 1 },
            }
          : { status: "unavailable", reason: "no_data" };
      });
  return scaleTotals(
    {
      cost: cost.isOk()
        ? {
            status: "complete",
            lower: cost.value.value,
            upper: null,
            coverage: { covered: 1, total: 1 },
          }
        : { status: "unavailable", reason: "no_data" },
      nutrition,
    },
    grams / 100,
  );
}

/** A package label overrides USDA serving weights, including when they conflict. */
export function productServingGrams(
  product: ProductWithMappingsAndFoodOut,
): number | null {
  if (product.labelNutrition) return product.labelNutrition.servingGrams;
  const result = safeConvertAmount(
    { value: 1, unit: "serving" },
    getAllUnitMappingsFromProduct(product),
    "weight",
  );
  return result.isOk() && result.value.value > 0 ? result.value.value : null;
}
