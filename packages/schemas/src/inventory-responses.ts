import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { externalIdOut } from "./external-id";
import { imageOut } from "./image";
import { inventoryEntryOut } from "./inventory";
import {
  locationId,
  locationShortcode,
  productId,
  productShortcode,
} from "./identifiers";
import { locationOut, locationType } from "./location";
import { productCategory } from "./product";
import { unitMappingOut } from "./unitmapping";

export const productInventoryEmbedOut = z.object({
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
});

export const inventoryWithProductOut = inventoryEntryOut.extend({
  product: productInventoryEmbedOut,
});

export const inventoryWithLocationOut = inventoryEntryOut.extend({
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

export const inventoryListLocationOut = z.object({
  id: locationId,
  shortcode: locationShortcode,
  name: z.string(),
  type: locationType,
});

export const inventoryListItemOut = inventoryEntryOut.extend({
  product: inventoryListProductOut,
  location: inventoryListLocationOut,
});
export type InventoryListItemOut = z.infer<typeof inventoryListItemOut>;

export const inventoryDetailProductOut = productInventoryEmbedOut.extend({
  images: z.array(imageOut),
  externalIds: z.array(externalIdOut),
  unitMappings: z.array(unitMappingOut),
});

export const inventoryWithLocationAndProductOut = inventoryEntryOut.extend({
  product: inventoryDetailProductOut,
  location: locationOut,
});
export type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;
