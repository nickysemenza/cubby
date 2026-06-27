import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { ingredientOut } from "./ingredient";
import {
  inventoryListLocationOut,
  inventoryWithLocationOut,
} from "./inventory-responses";
import { inventoryEntryOut } from "./inventory";
import { productTopLevelOut } from "./product";
import { recipeUsageOut } from "./recipe-responses";
import { recomputeSummary } from "./recipe-shared";
import { unitMappingOut } from "./unitmapping";

export const productWithMappingsOut = productTopLevelOut.extend({
  unitMappings: z.array(unitMappingOut),
});
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export const productPickerItemOut = productTopLevelOut.pick({
  id: true,
  shortcode: true,
  name: true,
  manufacturer: true,
});
export type ProductPickerItemOut = z.infer<typeof productPickerItemOut>;

export const productWithIngredientAndInventoryAndMappingsOut =
  productTopLevelOut.extend({
    ingredient: ingredientOut.nullable(),
    unitMappings: z.array(unitMappingOut),
    inventoryEntry: z.array(inventoryWithLocationOut),
  });

export const productListInventoryEntryOut = inventoryEntryOut.extend({
  location: inventoryListLocationOut,
});

// Product list rows stay list-shaped. USDA summaries and recipe usages hydrate
// through separate/detail paths so list paint is not blocked by ancillary data.
export const productListItemOut = productWithMappingsOut.extend({
  ingredient: ingredientOut.nullable(),
  inventoryEntry: z.array(productListInventoryEntryOut),
});
export type ProductListItem = z.infer<typeof productListItemOut>;

// Enriched product shape for detail/create/update responses. recipeUsages is
// required here because this schema represents a fully hydrated product detail
// response, not list rows or lazy-loaded recipe usage data.
export const productWithFoodOut =
  productWithIngredientAndInventoryAndMappingsOut.extend({
    food: foodSummary.nullable(),
    recipeUsages: z.array(recipeUsageOut),
  });
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export const productWithFoodAndSideEffectsOut = productWithFoodOut.extend({
  sideEffects: recomputeSummary,
});
export type ProductWithFoodAndSideEffectsOut = z.infer<
  typeof productWithFoodAndSideEffectsOut
>;
