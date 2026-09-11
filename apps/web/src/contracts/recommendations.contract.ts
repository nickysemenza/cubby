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

import { defineContract, mutation, query } from "~/contracts/define";

export const relatednessContract = defineContract("relatedness", {
  product: query({
    input: productShortcode,
    output: relatednessOutSchema,
  }),
});

export const recommendationsContract = defineContract("recommendations", {
  placement: query({
    input: placementRecommendationInput,
    output: placementRecommendationOut,
  }),
  product: query({
    input: recommendationWorkbenchInput,
    output: recommendationWorkbenchOut,
  }),
  duplicateProduct: query({
    input: duplicateProductRecommendationInput,
    output: duplicateProductRecommendationOut,
  }),
  tagPropagation: query({
    input: tagPropagationRecommendationInput,
    output: tagPropagationRecommendationOut,
  }),
  dismissDuplicateProduct: mutation({
    input: dismissDuplicateProductRecommendationInput,
    output: recommendationOkSchema,
  }),
  dismissTagPropagation: mutation({
    input: dismissTagPropagationInput,
    output: recommendationOkSchema,
  }),
  dismissProduct: mutation({
    input: dismissProductRecommendationInput,
    output: recommendationOkSchema,
  }),
});
