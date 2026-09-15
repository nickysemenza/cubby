import type { WFoodAmountInput, WNutritionTotals } from "@cubby/recipebridge";
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type {
  MealFoodAmount,
  MealFoodNutrients,
  MealPreparationYieldBasis,
} from "@cubby/schemas/meal";
import {
  type MeasureEstimate,
  type NutritionTotals,
} from "@cubby/schemas/nutrition";
import type { ProductWithMappingsAndFoodOut } from "@cubby/schemas/product";
import type { RecipeYield } from "@cubby/schemas/recipe-shared";
import {
  isNutrientKey,
  TIER1_NUTRIENT_KEYS,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";

import {
  fromNamedEstimates,
  fromWMeasureEstimate,
} from "./nutrition-estimates";
import {
  nutrientTargets,
  safeConvertAmount,
  toWAmount,
  toWProductInput,
} from "./recipe-costing";
import { getAllUnitMappingsFromProduct } from "./unit-mapping-utils";
import { wasm } from "./wasm";

export type FoodAmountSource =
  | { kind: "product"; product: ProductWithMappingsAndFoodOut }
  | { kind: "ingredient"; ingredient: IngredientWithFoodLeanOut }
  | {
      kind: "recipe";
      /** Current batch totals, already multiplied by `scale`. */
      batch: NutritionTotals;
      yieldBasis: MealPreparationYieldBasis;
      recipeYield: RecipeYield | null;
      /** Servings in the unscaled recipe. */
      servings: number | null;
      scale: number;
    }
  | { kind: "manual"; nutrients: MealFoodNutrients }
  | { kind: "unavailable" };

export type FoodAmountCalculation = {
  totals: NutritionTotals;
  /** Exact resolved weight only; ranged weights remain represented in `weight`. */
  grams: number | null;
  weight: MeasureEstimate;
  /** Fraction of the current prepared batch; only recipe sources provide it. */
  batchShare: MeasureEstimate;
};

const toWTotals = (totals: NutritionTotals): WNutritionTotals => ({
  cost: totals.cost,
  nutrition: TIER1_NUTRIENT_KEYS.map((key) => ({
    code: TIER1_NUTRIENTS[key].code,
    estimate: totals.nutrition[key],
  })),
});

const fromWTotals = (totals: WNutritionTotals): NutritionTotals => ({
  cost: fromWMeasureEstimate(totals.cost),
  nutrition: fromNamedEstimates(totals.nutrition),
});

const mappedSource = (
  products: ProductWithMappingsAndFoodOut[],
): WFoodAmountInput["source"] => ({
  kind: "mapped",
  products: products.map((product) => {
    const input = toWProductInput(product);
    return product.labelNutrition
      ? {
          ...input,
          // A package label defines what "serving" means for this product.
          // Append it after stored/USDA mappings so the conversion graph's
          // last-edge-wins rule gives the label the same precedence as its
          // nutrient values, without equating a serving with `each` (package).
          unit_mappings: [
            ...input.unit_mappings,
            {
              a: { value: 1, unit: "serving" },
              b: {
                value: product.labelNutrition.servingGrams,
                unit: "g",
              },
              source: "label serving",
              sourceMetadata: { type: "product", productId: product.id },
            },
          ],
        }
      : input;
  }),
});

const toWSource = (source: FoodAmountSource): WFoodAmountInput["source"] => {
  switch (source.kind) {
    case "product":
      return mappedSource([source.product]);
    case "ingredient":
      return mappedSource(source.ingredient.product);
    case "recipe":
      return {
        kind: "recipe",
        batch: toWTotals(source.batch),
        yield_basis: {
          kind: source.yieldBasis.kind,
          lower_grams: source.yieldBasis.lowerGrams,
          upper_grams: source.yieldBasis.upperGrams,
        },
        recipe_yield: source.recipeYield ? toWAmount(source.recipeYield) : null,
        servings: source.servings,
        scale: source.scale,
      };
    case "manual":
      return {
        kind: "manual",
        nutrients: Object.entries(source.nutrients).flatMap(([key, value]) =>
          value == null || !isNutrientKey(key)
            ? []
            : [{ code: TIER1_NUTRIENTS[key].code, value }],
        ),
      };
    case "unavailable":
      return { kind: "unavailable" };
  }
};

/**
 * Resolve one logged amount against its current source data. Unit conversion,
 * product graph merging, price selection, and recipe-yield range arithmetic
 * live in recipebridge; unknown or stale source units become unavailable data.
 */
export const calculateFoodAmount = (
  amount: MealFoodAmount | null,
  source: FoodAmountSource,
): FoodAmountCalculation => {
  const result = wasm.calculate_food_amount({
    amount: amount ? toWAmount(amount) : null,
    source: toWSource(source),
    nutrient_targets: nutrientTargets(),
  });
  return {
    totals: fromWTotals(result.totals),
    grams: result.grams ?? null,
    weight: fromWMeasureEstimate(result.weight),
    batchShare: fromWMeasureEstimate(result.batch_share),
  };
};

export const manualFoodTotals = (
  nutrients: MealFoodNutrients,
): NutritionTotals =>
  calculateFoodAmount(null, { kind: "manual", nutrients }).totals;

export function productFoodTotals(
  product: ProductWithMappingsAndFoodOut,
  grams: number,
): NutritionTotals {
  return calculateFoodAmount(
    { value: grams, unit: "g" },
    { kind: "product", product },
  ).totals;
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
