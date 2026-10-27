import {
  rawProductCategorySummary,
  productCategoryFeature,
} from "./product-category-fields";
import { locationTypeValues } from "@cubby/shared";
import { z } from "zod";
import { productShortcode, locationShortcode } from "./identifier-fields";
import { money, moneyNullable } from "./money";

export const locationType = z
  .enum(locationTypeValues)
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

/** Location identity for stock, scan, and recommendation responses. */
export const locationRefOut = z.object({
  id: locationShortcode,
  name: z.string(),
});
export const locationListRefOut = locationRefOut.extend({
  type: locationType.nullable(),
});

const pricingCounts = z.object({
  priced: z.number().int().nonnegative(),
  missingPricing: z.number().int().nonnegative(),
  miscNoPrice: z.number().int().nonnegative(),
});

export const locationValuationTotals = z.object({
  directValuation: money,
  totalValuation: money,
  directItemCount: z.number().int().nonnegative(),
  totalItemCount: z.number().int().nonnegative(),
});

export const locationValuation = locationValuationTotals.extend({
  direct: pricingCounts,
  total: pricingCounts,
  installed: locationValuationTotals.optional(),
  container: locationValuationTotals.optional(),
});
export type LocationValuation = z.infer<typeof locationValuation>;

export const locationIdentityProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  brandName: z.string().nullable(),
  model: z.string().nullable(),
  category: rawProductCategorySummary.nullable(),
  categoryFeature: productCategoryFeature.nullable(),
  price: moneyNullable,
});
export type LocationIdentityProductOut = z.infer<
  typeof locationIdentityProductOut
>;

import { fdcId } from "@cubby/usda";
import { gtin } from "./external-id";
import { inventoryShortcode } from "./identifier-fields";
import { timestampedFields } from "./base-entity";
import { amount } from "./codec";
import { displayImagesField } from "./display-images";
import { listLabel } from "./entity-definitions/label-field";
export const inventoryItemForTree = z.object({
  id: inventoryShortcode,
  amount,
  productName: z.string(),
  productId: productShortcode,
});
export type InventoryItemForTree = z.infer<typeof inventoryItemForTree>;

export function locationReadSchemas<S extends z.ZodRawShape>(
  base: z.ZodObject<S>,
) {
  const locationProductCategory = rawProductCategorySummary;

  const locationInventoryProductOut = z.object({
    id: productShortcode,
    name: z.string(),
    primaryGtin: gtin.nullable(),
    fdc_id: fdcId.nullable(),
    brandName: z.string().nullable(),
    model: z.string().nullable(),
    notes: z.string().nullable(),
    expectedQuantity: z.number().int().positive().nullable(),
    category: locationProductCategory.nullable(),
    categoryFeature: productCategoryFeature.nullable(),
    price: moneyNullable,
    usdaUnavailable: z.boolean().nullable(),
    ...timestampedFields,
  });

  const locationInventoryWithProductOut = z.object({
    id: inventoryShortcode,
    amount,
    valuation: moneyNullable,
    ...timestampedFields,
    product: locationInventoryProductOut,
  });

  const list = base.extend({
    displayImages: displayImagesField,
    // Server-composed text for the Valuation column.
    valuationLabel: listLabel,
    children: z.array(locationListRefOut),
    parent: locationListRefOut.nullable(),
    inventoryEntries: z.array(locationInventoryWithProductOut),
  });

  type RecursiveLocation = z.output<typeof base> & {
    displayImages?: z.output<typeof displayImagesField>;
    children?: RecursiveLocation[];
    parent?: RecursiveLocation;
    childCount?: number;
    directItemCount?: number;
    totalItemCount?: number;
    inventoryItems?: InventoryItemForTree[];
  };
  const detail: z.ZodObject<
    S & {
      displayImages: z.ZodOptional<typeof displayImagesField>;
      children: z.ZodOptional<z.ZodLazy<z.ZodType<RecursiveLocation[]>>>;
      parent: z.ZodOptional<z.ZodLazy<z.ZodType<RecursiveLocation>>>;
      childCount: z.ZodOptional<z.ZodNumber>;
      directItemCount: z.ZodOptional<z.ZodNumber>;
      totalItemCount: z.ZodOptional<z.ZodNumber>;
      inventoryItems: z.ZodOptional<z.ZodArray<typeof inventoryItemForTree>>;
    }
  > = z.object({
    ...base.shape,
    displayImages: displayImagesField.optional(),
    children: z
      .lazy((): z.ZodType<RecursiveLocation[]> => recursiveSchema().array())
      .optional(),
    parent: z
      .lazy((): z.ZodType<RecursiveLocation> => recursiveSchema())
      .optional(),
    childCount: z.number().int().nonnegative().optional(),
    directItemCount: z.number().int().nonnegative().optional(),
    totalItemCount: z.number().int().nonnegative().optional(),
    inventoryItems: z.array(inventoryItemForTree).optional(),
  });
  function recursiveSchema(): z.ZodType<RecursiveLocation> {
    // SAFETY: this object spreads the exact base shape and adds only the recursive fields described by RecursiveLocation.
    return detail as z.ZodType<RecursiveLocation>;
  }
  return { output: base, list, detail };
}
