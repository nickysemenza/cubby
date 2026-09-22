import {
  recommendationsContract,
  relatednessContract,
} from "~/contracts/recommendations.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const relatedness = defineOperationDomain(relatednessContract, {
  product: { tags: [["relatedness", "product"]] },
});

export const recommendations = defineOperationDomain(recommendationsContract, {
  forEntity: {
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
  placement: { tags: [["recommendations", "placement"]] },
  product: { tags: [["recommendations", "product"]] },
  duplicateProduct: { tags: [["recommendations", "duplicateProduct"]] },
  tagPropagation: { tags: [["recommendations", "tagPropagation"]] },
  dismissDuplicateProduct: { invalidates: ripple.recommendations },
  dismissTagPropagation: { invalidates: ripple.recommendations },
  dismissProduct: { invalidates: ripple.recommendations },
  productMatches: {
    tags: [["recommendations", "productMatches"], ["product"]],
  },
  proposeProductMatch: { invalidates: ripple.recommendations },
  dismissProductMatch: { invalidates: ripple.recommendations },
  mergeProductMatch: { invalidates: ripple.productMerge },
});
