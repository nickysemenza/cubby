import { z } from "zod";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { productTopLevelOut } from "./product";
import { ingredientBase } from "./ingredient";
import { UnitMapping, unitMappingOut } from "./unitmapping";
import { recipeTopLevel } from "./recipe";
import { brandedFoodSummary } from "./usda";

export const inventoryWithProductOut = inventoryEntryOut.merge(
  z.object({
    product: productTopLevelOut,
  }),
);

export const inventoryWithLocationOut = inventoryEntryOut.merge(
  z.object({
    location: locationOut,
  }),
);

export const inventoryWithLocationAndProductOut = inventoryEntryOut.merge(
  z.object({
    product: productTopLevelOut,
    location: locationOut,
  }),
);

export const productWithIngredientAndInventoryAndMappingsOut =
  productTopLevelOut.merge(
    z.object({
      ingredient: ingredientBase.nullable(),
      unitMappings: z.array(unitMappingOut),
      inventoryEntry: z.array(inventoryWithLocationOut),
      food: brandedFoodSummary.nullable(),
    }),
  );

const productWithMappingsAndFoodOut = productTopLevelOut.merge(
  z.object({
    unitMappings: z.array(unitMappingOut),
    food: brandedFoodSummary.nullable(),
  }),
);
export type IngredientOut = z.infer<typeof ingredientWithRecipesAndProductOut>;

export const ingredientWithRecipesAndProductOut = z
  .object({
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productWithMappingsAndFoodOut),
  })
  .merge(ingredientBase);

export const locationOutWithParentChildrenAndInventoryOut = z
  .object({
    children: z.array(locationOut),
    parent: locationOut.nullable(),
    inventoryEntries: z.array(inventoryWithProductOut),
  })
  .merge(locationOut);

export const unitMappignsFromProduct = (
  product: z.infer<typeof productWithMappingsAndFoodOut>,
): UnitMapping[] => {
  const serving = product.food?.brandedFoodInfo?.serving_as_amount;
  return [...product.unitMappings, ...(serving ? [serving] : [])];
};
