import { z } from "zod";
import { computedFieldEnvelope, fieldEnvelope } from "./field-envelope";

import { recordEmojiField } from "./emoji";
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
  category: { feature: ProductCategoryFeature | null } | null | undefined,
): boolean =>
  category?.feature != null &&
  SERVICE_PRODUCT_FEATURES.some((feature) => feature === category.feature);

export const isServiceProductFeature = (
  feature: ProductCategoryFeature | null | undefined,
): boolean => feature != null && SERVICE_PRODUCT_FEATURES.includes(feature);

export const productCategoryPathNode = z.object({
  id: productCategoryShortcode,
  name: z.string().min(1),
});
export type ProductCategoryPathNode = z.infer<typeof productCategoryPathNode>;

/** The compact tree projection embedded in Product reads. */
export const rawProductCategorySummary = z.object({
  id: productCategoryShortcode,
  name: z.string().min(1),
  path: z.array(productCategoryPathNode).min(1).max(3),
  feature: productCategoryFeature.nullable(),
});
export type RawProductCategorySummary = z.infer<
  typeof rawProductCategorySummary
>;
/** A current category reference keeps its derived ancestry in the canonical envelope. */
export const productCategorySummary = z.object({
  id: productCategoryShortcode,
  name: z.string().min(1),
  fields: z.object({
    path: computedFieldEnvelope(rawProductCategorySummary.shape.path),
  }),
});
export type ProductCategorySummary = z.infer<typeof productCategorySummary>;

/** Purchase-line evidence for a category in Vendor reads and classification. */
export const rawPurchasedCategorySummary = z.object({
  id: productCategoryShortcode,
  name: z.string(),
  emoji: z.string().nullable(),
  principalLineCount: z.number().int(),
  distinctPurchaseCount: z.number().int(),
});

/** Current Vendor category reads retain usage evidence beside authoritative category emoji. */
export const purchasedCategorySummary = rawPurchasedCategorySummary
  .omit({ emoji: true })
  .extend({
    fields: z.object({
      emoji: fieldEnvelope(
        recordEmojiField.validation.update,
        recordEmojiField.validation.read,
      ),
    }),
  });
