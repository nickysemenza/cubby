import { fdcId, foodSummary, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { amount } from "./codec";
import { externalIdOut } from "./external-id-responses";
import { imageOut } from "./image-responses";
import { ingredientOut } from "./ingredient";
import {
  inventoryListLocationOut,
  inventoryWithLocationOut,
} from "./inventory-responses";
import { inventoryId, productId, productShortcode } from "./identifiers";
import { productCategory, productTopLevelOut } from "./product";
import { recipeUsageOut } from "./recipe-responses";
import { recomputeSummary } from "./recipe-shared";
import {
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping-responses";

const productTopLevelResponseFields = {
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  upc: upc.nullable(),
  fdc_id: fdcId.nullable(),
  manufacturer: z.string(),
  model: z.string().nullish(),
  notes: z.string().nullish(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: productCategory.nullable(),
  images: z.array(imageOut),
  externalIds: z.array(externalIdOut),
  price: z.number().nullable(),
  usdaUnavailable: z.boolean().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const productWithMappingsOut = z.object({
  ...productTopLevelResponseFields,
  unitMappings: z.array(unitMappingOut),
});
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export const productWithMappingsAndFoodOut = z.object({
  ...productTopLevelResponseFields,
  unitMappings: z.array(unitMappingOut),
  food: foodSummary.nullable(),
});
export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

export const productPickerItemOut = z.object({
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
});
export type ProductPickerItemOut = z.infer<typeof productPickerItemOut>;

export const productWithIngredientAndInventoryAndMappingsOut = z.object({
  ...productTopLevelResponseFields,
  ingredient: ingredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(inventoryWithLocationOut),
});

export const productListInventoryEntryOut = z.object({
  id: inventoryId,
  amount,
  valuation: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  location: inventoryListLocationOut,
});

// Product list rows stay list-shaped. USDA summaries and recipe usages hydrate
// through separate/detail paths so list paint is not blocked by ancillary data.
export const productListItemOut = z.object({
  ...productTopLevelResponseFields,
  unitMappings: z.array(unitMappingOut),
  ingredient: ingredientOut.nullable(),
  inventoryEntry: z.array(productListInventoryEntryOut),
});
export type ProductListItem = z.infer<typeof productListItemOut>;

// Enriched product shape for detail/create/update responses. recipeUsages is
// required here because this schema represents a fully hydrated product detail
// response, not list rows or lazy-loaded recipe usage data.
export const productWithFoodOut = z.object({
  ...productTopLevelResponseFields,
  ingredient: ingredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(inventoryWithLocationOut),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
});
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export const productWithFoodAndSideEffectsOut = z.object({
  ...productTopLevelResponseFields,
  ingredient: ingredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(inventoryWithLocationOut),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
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
