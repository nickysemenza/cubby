import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { ingredientOut } from "./ingredient";
import { inventoryWithLocationOut } from "./inventory-responses";
import { productTopLevelOut } from "./product";
import { recipeUsageOut } from "./recipe";
import { unitMappingOut } from "./unitmapping";

export const productWithMappingsOut = productTopLevelOut.extend({
  unitMappings: z.array(unitMappingOut),
});
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export const productWithIngredientAndInventoryAndMappingsOut =
  productTopLevelOut.extend({
    ingredient: ingredientOut.nullable(),
    unitMappings: z.array(unitMappingOut),
    inventoryEntry: z.array(inventoryWithLocationOut),
  });

// Product list rows stay DB-only. USDA summaries and recipe usages hydrate
// through separate/detail paths so list paint is not blocked by ancillary data.
export const productListItemOut =
  productWithIngredientAndInventoryAndMappingsOut;
export type ProductListItem = z.infer<typeof productListItemOut>;

// Enriched product shape for detail/create/update responses.
export const productWithFoodOut =
  productWithIngredientAndInventoryAndMappingsOut.extend({
    food: foodSummary.nullable(),
    recipeUsages: z.array(recipeUsageOut),
  });
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;
