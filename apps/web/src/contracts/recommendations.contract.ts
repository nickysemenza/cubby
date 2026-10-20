import {
  entityRecommendationsInput,
  entityRecommendationsOut,
} from "@cubby/schemas/entity-recommendations";
import { productShortcode } from "@cubby/schemas/identifiers";
import {
  mergeProductMatchInput,
  proposeProductMatchInput,
  proposeProductMatchOut,
  recommendationOkSchema,
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
  proposeProductMatch: mutation({
    input: proposeProductMatchInput,
    output: proposeProductMatchOut,
    invalidates: ["recommendations"],
  }),
  mergeProductMatch: mutation({
    input: mergeProductMatchInput,
    output: recommendationOkSchema,
    invalidates: ["productMerge"],
  }),
});
