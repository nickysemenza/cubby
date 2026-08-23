import { z } from "zod";
import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { duplicateProductIdentitySchema } from "./problems";
import { embeddingReadinessSchema, relatednessOutSchema } from "./relatedness";

export const recommendationWorkbenchInput = z.object({
  sourceId: productShortcode,
});

export const recommendationKind = z.enum([
  "product-related",
  "duplicate-product",
  "tag-propagation",
  "placement",
]);
export type RecommendationKind = z.infer<typeof recommendationKind>;

/** Only an entity shortcode is permitted in the workbench URL. */
export const recommendationWorkbenchSearch = z
  .object({
    kind: recommendationKind,
    source: productShortcode.optional(),
    inventory: inventoryShortcode.optional(),
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
export const dismissDuplicateProductRecommendationInput = z.object({
  sourceId: productShortcode,
});

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

export const placementRecommendationInput = z.object({
  inventoryId: inventoryShortcode,
});
export const placementRecommendationOut = z
  .object({
    inventoryId: inventoryShortcode,
    productName: z.string(),
    sourceLocation: z.object({ id: locationShortcode, name: z.string() }),
    destination: z.object({ id: locationShortcode, name: z.string() }),
  })
  .nullable();
