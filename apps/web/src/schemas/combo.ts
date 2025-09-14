import { z } from "zod";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { productTopLevelOut } from "./product";
import { ingredientOut } from "./ingredient";
import {
  UnitMapping,
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping";
import { recipeTopLevel } from "./recipe";
import { FoodSummary, foodSummary } from "@recipehub/usda-schemas";
import { imageOut } from "./image";

const inventoryWithProductOut = inventoryEntryOut.extend(
  z.object({
    product: productTopLevelOut,
  }).shape,
);

const inventoryWithLocationOut = inventoryEntryOut.extend(
  z.object({
    location: locationOut,
  }).shape,
);

export const inventoryWithLocationAndProductOut = inventoryEntryOut.extend(
  z.object({
    product: productTopLevelOut.extend(
      z.object({
        unitMappings: z.array(unitMappingOut),
      }).shape,
    ),
    location: locationOut,
  }).shape,
);

export const productWithIngredientAndInventoryAndMappingsOut =
  productTopLevelOut.extend(
    z.object({
      ingredient: ingredientOut.nullable(),
      unitMappings: z.array(unitMappingOut),
      inventoryEntry: z.array(inventoryWithLocationOut),
    }).shape,
  );

const productWithMappingsOut = productTopLevelOut.extend(
  z.object({
    unitMappings: z.array(unitMappingOut),
  }).shape,
);
export type IngredientWithRecipesAndProductOut = z.infer<
  typeof ingredientWithRecipesAndProductOut
>;

export const ingredientWithRecipesAndProductOut = z
  .object({
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productWithMappingsOut),
  })
  .extend(ingredientOut.shape);

export const locationOutWithParentChildrenAndInventoryOut = z
  .object({
    children: z.array(locationOut),
    parent: locationOut.nullable(),
    inventoryEntries: z.array(inventoryWithProductOut),
    images: z.array(imageOut).optional(),
  })
  .extend(locationOut.shape);

export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

// Enhanced branded food info with calculated serving_as_amount
const brandedFoodInfoWithAmount = z.object({
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  branded_food_category: z.string().nullable(),
  gtin_upc: z.string(),
  ingredients: z.string().nullable(),
  serving: z.object({
    serving_size: z.number().nullable(),
    serving_size_unit: z.string().nullable(),
    household_serving_fulltext: z.string().nullable(),
  }),
  serving_as_amount: unitMappingWithMetadata.optional(),
});

// Enhanced food summary with unit mappings and linked products
export const foodSummaryWithLinkedProducts = foodSummary.extend({
  brandedFoodInfo: brandedFoodInfoWithAmount.nullable(),
  portionInfoParsed: z.array(unitMappingWithMetadata),
  linkedProducts: z.array(productTopLevelOut).optional(),
});

export type FoodSummaryWithLinkedProducts = z.infer<
  typeof foodSummaryWithLinkedProducts
>;

/**
 * Converts a raw food portion to a unit mapping
 */
export const unitMappingFromPortionInfo = (
  portionInfo: {
    amount: number;
    modifier: string | null;
    gram_weight: number;
  },
  fdc_id: number,
): UnitMapping => {
  return {
    a: {
      value: portionInfo.amount,
      unit: portionInfo.modifier ?? "portion",
    },
    b: {
      value: portionInfo.gram_weight,
      unit: "g",
    },
    source: `USDA portion`,
    sourceMetadata: { type: "food" as const, fdcId: fdc_id },
  };
};

/**
 * Creates unit mappings from nutrition data (e.g., 100g → 374kcal)
 */
const unitMappingsFromNutrition = (food: FoodSummary): UnitMapping[] => {
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

export const unitMappingsFromFood = (
  food: FoodSummary | FoodSummaryWithLinkedProducts,
): UnitMapping[] => {
  // Check if this is the enhanced type with serving_as_amount
  const serving =
    food.brandedFoodInfo && "serving_as_amount" in food.brandedFoodInfo
      ? (food.brandedFoodInfo as { serving_as_amount?: UnitMapping })
          .serving_as_amount
      : undefined;

  // Only try to access portionInfoParsed if it exists (enhanced type)
  const parsedPortions =
    "portionInfoParsed" in food ? food.portionInfoParsed : [];

  return [
    ...parsedPortions,
    ...(serving ? [serving] : []),
    ...(food ? unitMappingsFromNutrition(food) : []),
  ];
};

/**
 * Gets all unit mappings from a product, including both direct unit mappings
 * and mappings derived from food data
 */
export const getAllUnitMappingsFromProduct = (product: {
  unitMappings: UnitMapping[];
  food?: FoodSummary | null;
}): UnitMapping[] => {
  return [
    ...product.unitMappings,
    ...(product.food ? unitMappingsFromFood(product.food) : []),
  ];
};
