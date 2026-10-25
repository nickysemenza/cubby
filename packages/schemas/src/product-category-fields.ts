import { z } from "zod";
import type { ProductCategory } from "@cubby/shared";

import { productCategoryShortcode } from "./identifier-fields";

/**
 * A behavior namespace, not a second classification system. Descendants inherit
 * the closest binding, so moving a product within one category tree preserves
 * its stable feature behavior.
 */
export const productCategoryFeatureValues = [
  "food",
  "books",
  "music",
  "tools",
  "tool-consumables",
  "tool-accessories",
  "storage",
  "hardware",
  "electronics",
  "software",
  "services",
  "household",
  "supplies",
  "apparel",
] as const;

/** Root, group, and type are the only supported classification levels. */
export const PRODUCT_CATEGORY_MAX_DEPTH = 3;

export const productCategoryFeature = z.enum(productCategoryFeatureValues);
export type ProductCategoryFeature = z.infer<typeof productCategoryFeature>;

/** Service charges buy access or usage; their quantities never accumulate stock. */
export const SERVICE_PRODUCT_FEATURES: readonly ProductCategoryFeature[] = [
  "software",
  "services",
];

export const isServiceProductCategory = (
  category: Pick<ProductCategory, "feature"> | null | undefined,
): boolean =>
  category?.feature != null &&
  SERVICE_PRODUCT_FEATURES.some((feature) => feature === category.feature);

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

/** Purchase-line evidence for a category in Vendor reads and classification. */
export const purchasedCategorySummary = z.object({
  id: productCategoryShortcode,
  name: z.string(),
  emoji: z.string().nullable(),
  principalLineCount: z.number().int(),
  distinctPurchaseCount: z.number().int(),
});
