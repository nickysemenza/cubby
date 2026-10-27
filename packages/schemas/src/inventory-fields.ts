import { productCategoryFeature } from "./product-category-fields";
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
import { rawProductCategory } from "./product-fields";
import { imageOut } from "./entity-definitions/field-primitives";
import { unitMappingOut } from "./unitmapping";
import { locationListRefOut } from "./location-fields";
import { displayImagesField } from "./display-images";
const productInventoryEmbedFields = {
  id: productShortcode,
  name: z.string(),
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  brandName: z.string().nullable(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: rawProductCategory.nullable(),
  categoryFeature: productCategoryFeature.nullable(),
  price: moneyNullable,
  usdaUnavailable: z.boolean().nullable(),
  ...timestampedFields,
};

export const rawProductInventoryEmbed = z.object(productInventoryEmbedFields);
export type RawProductInventoryEmbed = z.infer<typeof rawProductInventoryEmbed>;

export const rawInventoryListProduct = z.object({
  id: productShortcode,
  name: z.string(),
  brandName: z.string().nullable(),
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  category: rawProductCategory.nullable(),
  categoryFeature: productCategoryFeature.nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  price: moneyNullable,
  usdaUnavailable: z.boolean().nullable(),
});
export type RawInventoryListProduct = z.infer<typeof rawInventoryListProduct>;

export const rawInventoryListLocation = locationListRefOut;
export type RawInventoryListLocation = z.infer<typeof rawInventoryListLocation>;

export const rawInventoryDetailProduct = z.object({
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
    product: rawInventoryListProduct,
    location: rawInventoryListLocation,
    displayName: z.string(),
  });
  const detail = base.extend({
    product: rawInventoryDetailProduct,
    location: rawInventoryListLocation,
    displayName: z.string(),
  });

  return { output: base, list, detail };
}
