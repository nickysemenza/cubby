import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { imageOut } from "./image-responses";
import { ingredientOut } from "./ingredient";
import {
  inventoryListLocationOut,
  inventoryWithLocationOut,
} from "./inventory-responses";
import { inventoryEntryOut } from "./inventory";
import { productCategory, productTopLevelOut } from "./product";
import { recipeUsageOut } from "./recipe-responses";
import { recomputeSummary } from "./recipe-shared";
import {
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping-responses";

export const productWithMappingsOut = productTopLevelOut.extend({
  unitMappings: z.array(unitMappingOut),
});
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export const productWithMappingsAndFoodOut = productWithMappingsOut.extend({
  food: foodSummary.nullable(),
});
export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

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

export const productFoodSummariesOut = z.record(
  z.string(),
  foodSummary.nullable(),
);

export const productImageSummariesOut = z.record(z.string(), z.array(imageOut));

export const productUnitMappingSummariesOut = z.record(
  z.string(),
  z.array(unitMappingWithMetadata),
);

export const productShortcodeListOut = z.array(productTopLevelOut);

export const productCategoryDistributionOut = z.array(
  z.object({
    category: productCategory.nullable(),
    productCount: z.number(),
    locations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        count: z.number(),
      }),
    ),
  }),
);
