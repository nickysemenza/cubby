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

/**
 * Declared behavior grants per feature — a capability matrix, not a second
 * classification system. Add a capability here instead of hard-coding a
 * feature-literal check at a call site: a category nested under a granted
 * feature (e.g. `tool-accessories` under `Tools`) then inherits the grant for
 * free, the same way it inherits the feature itself.
 */
export const productCategoryFeatureCapabilities = {
  food: { projectResource: false },
  books: { projectResource: false },
  tools: { projectResource: true },
  "tool-consumables": { projectResource: false },
  "tool-accessories": { projectResource: true },
  storage: { projectResource: false },
  hardware: { projectResource: false },
  electronics: { projectResource: false },
  software: { projectResource: true },
  household: { projectResource: false },
  supplies: { projectResource: false },
  apparel: { projectResource: false },
} as const satisfies Record<
  ProductCategoryFeature,
  { projectResource: boolean }
>;

/** Every feature that grants the project-resource capability. */
export const projectResourceFeatures = productCategoryFeatureValues.filter(
  (feature) => productCategoryFeatureCapabilities[feature].projectResource,
);

/** True when a resolved feature (or none) grants the project-resource capability. */
export const isProjectResourceFeature = (
  feature: ProductCategoryFeature | null,
): feature is ProductCategoryFeature =>
  feature !== null &&
  productCategoryFeatureCapabilities[feature].projectResource;

/** "tool-accessories" -> "Tool accessories" — sentence-case display label. */
const featureLabel = (feature: ProductCategoryFeature): string =>
  feature.charAt(0).toUpperCase() + feature.slice(1).replace(/-/g, " ");

/** User-facing list of the categories that grant the project-resource
 * capability, e.g. "Tools, Tool accessories, Software" — derived so error
 * text stays in sync with `productCategoryFeatureCapabilities`. */
export const projectResourceFeatureLabels = projectResourceFeatures
  .map(featureLabel)
  .join(", ");

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
