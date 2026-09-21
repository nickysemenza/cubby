import { z } from "zod";

import { productCategoryShortcode } from "./identifier-fields";

/**
 * A behavior namespace, not a second classification system. Descendants inherit
 * the closest binding, so moving a product within one category tree preserves
 * its stable feature behavior.
 */
export const productCategoryFeatureValues = [
  "food",
  "books",
  "tools",
  "tool-consumables",
  "tool-accessories",
  "storage",
  "hardware",
  "electronics",
  "software",
  "household",
  "supplies",
  "apparel",
] as const;

/** Root, group, and type are the only supported classification levels. */
export const PRODUCT_CATEGORY_MAX_DEPTH = 3;

export const productCategoryFeature = z.enum(productCategoryFeatureValues);
export type ProductCategoryFeature = z.infer<typeof productCategoryFeature>;

export const productCategoryPathNode = z.object({
  id: productCategoryShortcode,
  name: z.string().min(1),
});
export type ProductCategoryPathNode = z.infer<typeof productCategoryPathNode>;

/** The compact tree projection embedded in Product reads. */
export const productCategorySummary = z.object({
  id: productCategoryShortcode,
  name: z.string().min(1),
  path: z.array(productCategoryPathNode).min(1).max(3),
  feature: productCategoryFeature.nullable(),
});
export type ProductCategorySummary = z.infer<typeof productCategorySummary>;
