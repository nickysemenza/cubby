import { productShortcode } from "@cubby/schemas/identifiers";
import {
  dismissDuplicateProductRecommendationInput,
  dismissProductRecommendationInput,
  dismissTagPropagationInput,
  duplicateProductRecommendationInput,
  duplicateProductRecommendationOut,
  placementRecommendationInput,
  placementRecommendationOut,
  recommendationOkSchema,
  recommendationWorkbenchInput,
  recommendationWorkbenchOut,
  tagPropagationRecommendationInput,
  tagPropagationRecommendationOut,
} from "@cubby/schemas/recommendations";
import { relatednessOutSchema } from "@cubby/schemas/relatedness";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const relatedness = defineOperationDomain("relatedness", {
  product: query({
    input: productShortcode,
    output: relatednessOutSchema,
    tags: [["relatedness", "product"]],
  }),
});

export const recommendations = defineOperationDomain("recommendations", {
  placement: query({
    input: placementRecommendationInput,
    output: placementRecommendationOut,
    tags: [["recommendations", "placement"]],
  }),
  product: query({
    input: recommendationWorkbenchInput,
    output: recommendationWorkbenchOut,
    tags: [["recommendations", "product"]],
  }),
  duplicateProduct: query({
    input: duplicateProductRecommendationInput,
    output: duplicateProductRecommendationOut,
    tags: [["recommendations", "duplicateProduct"]],
  }),
  tagPropagation: query({
    input: tagPropagationRecommendationInput,
    output: tagPropagationRecommendationOut,
    tags: [["recommendations", "tagPropagation"]],
  }),
  dismissDuplicateProduct: mutation({
    input: dismissDuplicateProductRecommendationInput,
    output: recommendationOkSchema,
    invalidates: ripple.recommendations,
  }),
  dismissTagPropagation: mutation({
    input: dismissTagPropagationInput,
    output: recommendationOkSchema,
    invalidates: ripple.recommendations,
  }),
  dismissProduct: mutation({
    input: dismissProductRecommendationInput,
    output: recommendationOkSchema,
    invalidates: ripple.recommendations,
  }),
});
