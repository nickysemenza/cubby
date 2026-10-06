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
    mcp: { omit: "client_view" },
    input: productShortcode,
    output: relatednessOutSchema,
  }),
});

export const recommendationsContract = defineContract("recommendations", {
  forEntity: query({
    mcp: { omit: "client_view" },
    native: "Native inline relationship recommendations",
    input: entityRecommendationsInput,
    output: entityRecommendationsOut,
    cache: {
      tags: [
        ["recommendations", "forEntity"],
        ["expense"],
        ["project"],
        ["inventory"],
        ["location"],
        ["product"],
        ["task"],
        ["relatedness"],
      ],
    },
  }),
  placement: query({
    mcp: { omit: "client_view" },
    input: placementRecommendationInput,
    output: placementRecommendationOut,
  }),
  product: query({
    mcp: { omit: "client_view" },
    input: recommendationWorkbenchInput,
    output: recommendationWorkbenchOut,
  }),
  duplicateProduct: query({
    mcp: {
      omit: "client_view",
      note: "Agents rank duplicates with search.similar",
    },
    input: duplicateProductRecommendationInput,
    output: duplicateProductRecommendationOut,
  }),
  tagPropagation: query({
    mcp: { omit: "client_view" },
    input: tagPropagationRecommendationInput,
    output: tagPropagationRecommendationOut,
  }),
  dismissDuplicateProduct: mutation({
    mcp: { omit: "human_approval" },
    input: dismissDuplicateProductRecommendationInput,
    output: recommendationOkSchema,
    invalidates: ["recommendations"],
  }),
  dismissTagPropagation: mutation({
    mcp: { omit: "human_approval" },
    input: dismissTagPropagationInput,
    output: recommendationOkSchema,
    invalidates: ["recommendations"],
  }),
  dismissProduct: mutation({
    mcp: { omit: "human_approval" },
    input: dismissProductRecommendationInput,
    output: recommendationOkSchema,
    invalidates: ["recommendations"],
  }),
  productMatches: query({
    mcp: {
      omit: "human_approval",
      note: "The review queue for matches agents propose through product_enrichment.propose_match",
    },
    input: productMatchQueueInput,
    output: productMatchQueueOut,
    cache: { tags: [["recommendations", "productMatches"], ["product"]] },
  }),
  proposeProductMatch: mutation({
    input: proposeProductMatchInput,
    output: proposeProductMatchOut,
    invalidates: ["recommendations"],
  }),
  dismissProductMatch: mutation({
    mcp: { omit: "human_approval" },
    input: dismissProductMatchInput,
    output: recommendationOkSchema,
    invalidates: ["recommendations"],
  }),
  mergeProductMatch: mutation({
    mcp: { omit: "human_approval" },
    input: mergeProductMatchInput,
    output: recommendationOkSchema,
    invalidates: ["productMerge"],
  }),
});
