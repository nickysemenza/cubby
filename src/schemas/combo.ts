import { z } from "zod";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { productTopLevelOut } from "./product";
import { ingredientOut } from "./ingredient";
import { UnitMapping, unitMappingOut } from "./unitmapping";
import { recipeTopLevel } from "./recipe";
import { FoodSummary, foodSummary } from "./usda";
import { imageOut } from "./image";

const inventoryWithProductOut = inventoryEntryOut.merge(
  z.object({
    product: productTopLevelOut,
  }),
);

const inventoryWithLocationOut = inventoryEntryOut.merge(
  z.object({
    location: locationOut,
  }),
);

export const inventoryWithLocationAndProductOut = inventoryEntryOut.merge(
  z.object({
    product: productTopLevelOut.merge(
      z.object({
        unitMappings: z.array(unitMappingOut),
      }),
    ),
    location: locationOut,
  }),
);

export const productWithIngredientAndInventoryAndMappingsOut =
  productTopLevelOut.merge(
    z.object({
      ingredient: ingredientOut.nullable(),
      unitMappings: z.array(unitMappingOut),
      inventoryEntry: z.array(inventoryWithLocationOut),
      food: foodSummary.nullable(),
    }),
  );

const productWithMappingsAndFoodOut = productTopLevelOut.merge(
  z.object({
    unitMappings: z.array(unitMappingOut),
    food: foodSummary.nullable(),
  }),
);
export type IngredientWithRecipesAndProductOut = z.infer<
  typeof ingredientWithRecipesAndProductOut
>;

export const ingredientWithRecipesAndProductOut = z
  .object({
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productWithMappingsAndFoodOut),
  })
  .merge(ingredientOut);

export const locationOutWithParentChildrenAndInventoryOut = z
  .object({
    children: z.array(locationOut),
    parent: locationOut.nullable(),
    inventoryEntries: z.array(inventoryWithProductOut),
    images: z.array(imageOut).optional(),
  })
  .merge(locationOut);

export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;
/**
 * Creates unit mappings from nutrition data (e.g., 100g → 374kcal)
 */
export const unitMappingsFromNutrition = (food: FoodSummary): UnitMapping[] => {
  const nutrition = food.nutritionInfo?.nutrientsPer100;
  if (!nutrition) return [];
  const mappings: UnitMapping[] = [];
  const { fdc_id } = food;

  // Create calorie mapping: 100g → X kcal
  if (nutrition.kcal > 0) {
    mappings.push({
      a: { value: 100, unit: "g" },
      b: { value: nutrition.kcal, unit: "kcal" },
      source: `USDA nutrition`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    });
  }

  // Create protein mapping: 100g → X g protein
  if (nutrition.protein > 0) {
    mappings.push({
      a: { value: 100, unit: "g" },
      b: { value: nutrition.protein, unit: "g protein" },
      source: `USDA nutrition`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    });
  }

  return mappings;
};

export const unitMappingsFromProduct = (
  product: ProductWithMappingsAndFoodOut,
): UnitMapping[] => {
  const { food } = product;
  const foodMappings = food ? unitMappingsFromFood(food) : [];
  return [...product.unitMappings, ...foodMappings];
};

export const unitMappingsFromFood = (food: FoodSummary): UnitMapping[] => {
  const serving = food.brandedFoodInfo?.serving_as_amount;
  return [
    ...food.portionInfo.parsed,
    ...(serving ? [serving] : []),
    ...(food ? unitMappingsFromNutrition(food) : []),
  ];
};
