import { z } from "zod";
import { productShortcode } from "./identifiers";
import { duplicateProductIdentitySchema } from "./problems";
import { relatednessOutSchema } from "./relatedness";

export const recommendationWorkbenchInput = z.object({
  sourceId: productShortcode,
});

export const recommendationKind = z.enum([
  "product-related",
  "duplicate-product",
]);
export type RecommendationKind = z.infer<typeof recommendationKind>;

/** Only an entity shortcode is permitted in the workbench URL. */
export const recommendationWorkbenchSearch = z
  .object({
    kind: recommendationKind,
    source: productShortcode.optional(),
  })
  .strict();

export const dismissProductRecommendationInput = z.object({
  sourceId: productShortcode,
  targetId: productShortcode,
});

export const recommendationWorkbenchOut = relatednessOutSchema;

export const duplicateProductRecommendationInput = z.object({
  sourceId: productShortcode,
});
export const duplicateProductRecommendationOut =
  duplicateProductIdentitySchema.nullable();
