/**
 * Which relations a Product's category feature admits (project tool, Planting
 * source), read from the ProductCategory declaration's relation policies. Kept
 * out of `product-category-fields` because entity declarations import that
 * module, and these helpers read the policies generated from them.
 */
import { capitalize } from "@cubby/shared/text-case";

import {
  classificationValuesWhere,
  isFieldAllowed,
} from "./classification-field-policy";
import type { ProductCategoryFeature } from "./product-category-fields";

const featurePolicy = "productCategory.feature";

/** Every feature whose Products may be used as project resources (tools). */
export const projectResourceFeatures = classificationValuesWhere(
  featurePolicy,
  "projectTool",
  "unknown",
);

/**
 * True when a resolved feature (or none) admits use as a project resource.
 * The ProductCategory declaration's `projectTool` relation policy decides; a
 * nested category inherits it with the feature.
 */
export const isProjectResourceFeature = (
  feature: ProductCategoryFeature | null,
): feature is ProductCategoryFeature =>
  feature !== null && isFieldAllowed(featurePolicy, feature, "projectTool");

/** True when a Product with this feature may source a Planting. */
export const isPlantingSourceFeature = (
  feature: ProductCategoryFeature | null,
): boolean => isFieldAllowed(featurePolicy, feature, "plantingSource");

/** "tool-accessories" -> "Tool accessories" — sentence-case display label. */
const featureLabel = (feature: ProductCategoryFeature): string =>
  capitalize(feature.replace(/-/g, " "));

/** User-facing list of the categories that grant the project-resource
 * capability, e.g. "Tools, Tool accessories, Software" — derived so error
 * text stays in sync with the declared `projectTool` policy. */
export const projectResourceFeatureLabels = projectResourceFeatures
  .map(featureLabel)
  .join(", ");
