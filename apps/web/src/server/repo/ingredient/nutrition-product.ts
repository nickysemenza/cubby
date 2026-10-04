import type { IngredientNutritionProductOut } from "@cubby/schemas/ingredient";
import type { ProductWithMappingsAndFoodOut } from "@cubby/schemas/product";

import { buildNutritionDisplay } from "../product/nutrition-display";

/**
 * Nutrition and cost-per-nutrient must share one product's basis — pricing one
 * product's protein off a different product's nutrients would silently
 * misattribute cost. Pick the product carrying both (falling back to nutrition
 * alone when none has a price). A `labelNutrition` override is preferred over
 * USDA nutrition — the same precedence as `productWasmInputs`' costing — before
 * falling back to price.
 */
export function selectNutritionProduct(
  products: ProductWithMappingsAndFoodOut[],
): ProductWithMappingsAndFoodOut | undefined {
  return (
    products.find((p) => p.labelNutrition != null && p.price != null) ??
    products.find((p) => p.labelNutrition != null) ??
    products.find((p) => p.food?.nutritionInfo && p.price != null) ??
    products.find((p) => p.food?.nutritionInfo)
  );
}

export function buildIngredientNutritionProduct(
  products: ProductWithMappingsAndFoodOut[],
): IngredientNutritionProductOut | null {
  const product = selectNutritionProduct(products);
  if (!product) return null;
  return {
    productId: product.id,
    name: product.name,
    manufacturer: product.manufacturer,
    display: buildNutritionDisplay({
      labelNutrition: product.labelNutrition,
      food: product.food,
    }),
  };
}
