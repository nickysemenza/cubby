import { z } from "zod";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { productTopLevelOut } from "./product";
import { ingredientBase } from "./ingredient";
import { unitMappingOut } from "./unitmapping";
import { recipeTopLevel } from "./recipe";

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

export const productWithIngredientAndInventoryAndMappingsOut =
  productTopLevelOut.merge(
    z.object({
      ingredient: ingredientBase.nullable(),
      unitMappings: z.array(unitMappingOut),
      inventoryEntry: z.array(inventoryWithLocationOut),
    }),
  );

export type IngredientOut = z.infer<typeof ingredientWithRecipesAndProductOut>;

export const ingredientWithRecipesAndProductOut = z
  .object({
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productTopLevelOut),
  })
  .merge(ingredientBase);

export const locationOutWithParentChildrenAndInventoryOut = z
  .object({
    children: z.array(locationOut),
    parent: locationOut.nullable(),
    inventoryEntries: z.array(inventoryWithProductOut),
  })
  .merge(locationOut);
