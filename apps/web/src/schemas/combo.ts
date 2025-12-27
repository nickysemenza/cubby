import { foodSummary } from "@recipehub/usda-schemas";
import { z } from "zod";
import { imageOut } from "./image";
import { ingredientOut } from "./ingredient";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { productTopLevelOut } from "./product";
import { recipeTopLevel } from "./recipe";
import { unitMappingOut, unitMappingWithMetadata } from "./unitmapping";

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
    images: z.array(imageOut).default([]),
  })
  .extend(locationOut.shape);

export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

// Enhanced food summary with unit mappings and linked products
export const foodSummaryWithLinkedProducts = foodSummary.extend({
  inferredUnitMappings: z.array(unitMappingWithMetadata),
  linkedProducts: z.array(productTopLevelOut).optional(),
});

export type FoodSummaryWithLinkedProducts = z.infer<
  typeof foodSummaryWithLinkedProducts
>;
