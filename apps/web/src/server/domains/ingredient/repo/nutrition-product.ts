import { type IngredientNutritionProductOut } from "@cubby/schemas/ingredient";
import type { RawProductWithMappingsAndFood } from "@cubby/schemas/product-raw-read";

import { buildNutritionDisplay } from "~/server/domains/product/repo/nutrition-display";

/**
 * Nutrition and cost-per-nutrient must share one product's basis — pricing one
 * product's protein off a different product's nutrients would silently
 * misattribute cost. Pick the product carrying both (falling back to nutrition
 * alone when none has a price). A `labelNutrition` override is preferred over
 * USDA nutrition — the same precedence as `productWasmInputs`' costing — before
 * falling back to price.
 */
export function selectNutritionProduct(
  products: RawProductWithMappingsAndFood[],
): RawProductWithMappingsAndFood | undefined {
  return (
    products.find((p) => p.labelNutrition != null && p.price != null) ??
    products.find((p) => p.labelNutrition != null) ??
    products.find((p) => p.food?.nutritionInfo && p.price != null) ??
    products.find((p) => p.food?.nutritionInfo)
  );
}

export function buildIngredientNutritionProduct(
  products: RawProductWithMappingsAndFood[],
): IngredientNutritionProductOut | null {
  const product = selectNutritionProduct(products);
  if (!product) return null;
  return {
    productId: product.id,
    name: product.name,
    brandName: product.brandName,
    display: buildNutritionDisplay({
      labelNutrition: product.labelNutrition,
      food: product.food,
    }),
  };
}
