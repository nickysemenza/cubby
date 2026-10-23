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

export const relatednessContract = defineContract(
  "relatedness",
  {
    product: query({
      input: productShortcode,
      output: relatednessOutSchema,
    }),
  },
  { exposure: "view" },
);

export const recommendationsContract = defineContract(
  "recommendations",
  {
    forEntity: query({
      exposure: "view",
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
      description:
        'Propose that two Products are the same real item, for a person to review and merge in the product match queue. Use it when you hold evidence the automatic detector cannot see — typically a photo-created Product (e.g. "Gray crew t-shirt — M", stocked, never bought) and a purchase-created Product for the same item, confirmed against the vendor\'s product page. Never merges anything: it records the pair with your evidence, ranked above detector suggestions. Re-proposing the same pair (either order) records new immutable evidence; a pair the person dismissed stays dismissed and comes back with state "dismissed".',
      input: proposeProductMatchInput,
      output: proposeProductMatchOut,
      invalidates: ["recommendations"],
    }),
    mergeProductMatch: mutation({
      description:
        "Merge a queued match: mergeId folds into keepId, whose covers then lead with its own photos. Only for a pair the member agreed is one item.",
      destructive: true,
      input: mergeProductMatchInput,
      output: recommendationOkSchema,
      invalidates: ["productMerge"],
    }),
  },
  { exposure: "capability", mcpToolGroup: "product_enrichment" },
);
