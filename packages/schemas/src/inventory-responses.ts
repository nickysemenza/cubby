import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { amount } from "./codec";
import { externalIdOut } from "./external-id-responses";
import { imageOut } from "./image-responses";
import {
  inventoryId,
  locationId,
  locationShortcode,
  productId,
  productShortcode,
} from "./identifiers";
import { locationOut, locationType } from "./location";
import { productCategory } from "./product";
import { duplicateUniqueProductSchema } from "./problems";
import { unitMappingOut } from "./unitmapping-responses";

const inventoryEntryResponseFields = {
  id: inventoryId,
  amount,
  valuation: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

const productInventoryEmbedFields = {
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
  price: z.number().nullable(),
  usdaUnavailable: z.boolean().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const productInventoryEmbedOut = z.object(productInventoryEmbedFields);
export type ProductInventoryEmbedOut = z.infer<typeof productInventoryEmbedOut>;

export const inventoryWithProductOut = z.object({
  ...inventoryEntryResponseFields,
  product: productInventoryEmbedOut,
});

export const inventoryWithLocationOut = z.object({
  ...inventoryEntryResponseFields,
  location: locationOut,
});

export const inventoryListProductOut = z.object({
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  upc: upc.nullable(),
  fdc_id: fdcId.nullable(),
  category: productCategory.nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  model: z.string().nullish(),
  price: z.number().nullable(),
  usdaUnavailable: z.boolean().nullable(),
});
export type InventoryListProductOut = z.infer<typeof inventoryListProductOut>;

export const inventoryListLocationOut = z.object({
  id: locationId,
  shortcode: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type InventoryListLocationOut = z.infer<typeof inventoryListLocationOut>;

export const inventoryListItemOut = z.object({
  ...inventoryEntryResponseFields,
  product: inventoryListProductOut,
  location: inventoryListLocationOut,
});
export type InventoryListItemOut = z.infer<typeof inventoryListItemOut>;

export const inventoryDetailProductOut = z.object({
  ...productInventoryEmbedFields,
  images: z.array(imageOut),
  externalIds: z.array(externalIdOut),
  unitMappings: z.array(unitMappingOut),
});

export const inventoryWithLocationAndProductOut = z.object({
  ...inventoryEntryResponseFields,
  product: inventoryDetailProductOut,
  location: locationOut,
});
export type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;

export const inventoryWithLocationAndProductListOut = z.array(
  inventoryWithLocationAndProductOut,
);

export const inventoryDuplicateUniqueProductsOut = z.array(
  duplicateUniqueProductSchema,
);

export const inventoryCountsByLocationOut = z.record(z.string(), z.number());
