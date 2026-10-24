import { inventoryPlacementValues } from "@cubby/shared";
import { z } from "zod";
import { moneyNullable } from "./money";

/** Cycle-safe field schemas consumed by the generated Inventory contract. */
export const inventoryPlacement = z.enum(inventoryPlacementValues);

export const inventoryValuation = moneyNullable;
/**
 * A row's valuation state: valued, else whether its product has an effective
 * price the stored unit cannot reach (priceable) or none (unpriceable).
 */
export const inventoryValuationStatus = z.enum([
  "valued",
  "priceable",
  "unpriceable",
]);

import { fdcId } from "@cubby/usda";
import { productShortcode } from "./identifier-fields";
import { gtin, externalIdOut } from "./external-id";
import { timestampedFields } from "./base-entity";
import { productCategory } from "./product-fields";
import { imageOut } from "./entity-definitions/field-primitives";
import { unitMappingOut } from "./unitmapping";
import locationDefinition from "./entity-definitions/04-location.entity";
import { locationListRefOut } from "./location-fields";
import { displayImagesField } from "./display-images";
const locationOut = locationDefinition.readSchemas.output;
const productInventoryEmbedFields = {
  id: productShortcode,
  name: z.string(),
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  brandName: z.string().nullable(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: productCategory.nullable(),
  price: moneyNullable,
  usdaUnavailable: z.boolean().nullable(),
  ...timestampedFields,
};

export const productInventoryEmbedOut = z.object(productInventoryEmbedFields);
export type ProductInventoryEmbedOut = z.infer<typeof productInventoryEmbedOut>;

export const inventoryListProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  brandName: z.string().nullable(),
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  category: productCategory.nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  price: moneyNullable,
  usdaUnavailable: z.boolean().nullable(),
});
export type InventoryListProductOut = z.infer<typeof inventoryListProductOut>;

export const inventoryListLocationOut = locationListRefOut;
export type InventoryListLocationOut = z.infer<typeof inventoryListLocationOut>;

export const inventoryDetailProductOut = z.object({
  displayImages: displayImagesField.default([]),
  ...productInventoryEmbedFields,
  images: z.array(imageOut),
  externalIds: z.array(externalIdOut),
  unitMappings: z.array(unitMappingOut),
});

export function inventoryReadSchemas<S extends z.ZodRawShape>(
  base: z.ZodObject<S>,
) {
  const list = base.extend({
    displayImages: displayImagesField,
    product: inventoryListProductOut,
    location: inventoryListLocationOut,
    displayName: z.string(),
  });
  const detail = base.extend({
    product: inventoryDetailProductOut,
    location: locationOut,
    displayName: z.string(),
  });

  return { output: base, list, detail };
}
