import { productCategorySummary } from "./product-category-fields";
import { locationTypeValues } from "@cubby/shared";
import { z } from "zod";

import { imageOut } from "./entity-definitions/field-primitives";
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
  manufacturer: z.string(),
  model: z.string().nullable(),
  category: productCategorySummary.nullable(),
  coverImage: imageOut.nullable(),
  price: moneyNullable,
});
export type LocationIdentityProductOut = z.infer<
  typeof locationIdentityProductOut
>;
