import {
  entityRecommendationsInput,
  entityRecommendationsOut,
} from "@cubby/schemas/entity-recommendations";
import { productShortcode } from "@cubby/schemas/identifiers";
import {
  dismissDuplicateProductRecommendationInput,
  dismissProductRecommendationInput,
  dismissProductMatchInput,
  dismissTagPropagationInput,
  duplicateProductRecommendationInput,
  duplicateProductRecommendationOut,
  mergeProductMatchInput,
  placementRecommendationInput,
  productMatchQueueInput,
  productMatchQueueOut,
  proposeProductMatchInput,
  proposeProductMatchOut,
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
  forEntity: query({
    native: "Native inline relationship recommendations",
    input: entityRecommendationsInput,
    output: entityRecommendationsOut,
  }),
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
  productMatches: query({
    input: productMatchQueueInput,
    output: productMatchQueueOut,
  }),
  proposeProductMatch: mutation({
    mcp: {
      name: "propose_product_match",
      description:
        'Propose that two Products are the same real item, for a person to review and merge in the product match queue (Recommendations workbench). Use it when you hold evidence the automatic detector cannot see — typically a photo-created Product (e.g. "Gray crew t-shirt — M", stocked, never bought) and a purchase-created Product for the same item, confirmed against the vendor\'s product page. This never merges anything: it records the pair with your evidence, ranked above detector suggestions. Re-proposing the same pair (either order) replaces the evidence and sources; a pair the person already dismissed stays dismissed and comes back with state "dismissed".',
    },
    input: proposeProductMatchInput,
    output: proposeProductMatchOut,
  }),
  dismissProductMatch: mutation({
    input: dismissProductMatchInput,
    output: recommendationOkSchema,
  }),
  mergeProductMatch: mutation({
    input: mergeProductMatchInput,
    output: recommendationOkSchema,
  }),
});
