import { z } from "zod";
import { productShortcode } from "./identifiers";
import { duplicateProductIdentitySchema } from "./problems";
import { embeddingReadinessSchema, relatednessOutSchema } from "./relatedness";

export const recommendationWorkbenchInput = z.object({
  sourceId: productShortcode,
});

export const recommendationKind = z.enum([
  "product-related",
  "duplicate-product",
  "tag-propagation",
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

export const tagPropagationRecommendationInput = z.object({
  sourceId: productShortcode,
});
export const dismissTagPropagationInput = z.object({
  sourceId: productShortcode,
  tag: z.string().min(1),
});
export const tagPropagationRecommendationOut = z.object({
  status: embeddingReadinessSchema,
  currentTags: z.array(z.string()),
  proposals: z.array(
    z.object({
      tag: z.string(),
      supportingProductCount: z.number().int().positive(),
    }),
  ),
});
export type TagPropagationRecommendationOut = z.infer<
  typeof tagPropagationRecommendationOut
>;
