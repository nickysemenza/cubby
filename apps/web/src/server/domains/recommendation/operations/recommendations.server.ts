import {
  recommendationsContract,
  relatednessContract,
} from "~/contracts/recommendations.contract";
import {
  mergeProductMatch,
  proposeProductMatch,
} from "~/server/domains/product/repo/match/product-match-review";
import { getEntityRecommendations } from "~/server/domains/recommendation/service/entity-recommendations.service";
import { getProductRelatedness } from "~/server/generic/relatedness/service/relatedness.service";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const relatednessHandlers = implementOperationDomain(
  relatednessContract,
  {
    product: (context, input) => getProductRelatedness(context.db, input),
  },
);
export const recommendationsHandlers = implementOperationDomain(
  recommendationsContract,
  {
    forEntity: (context, input) => getEntityRecommendations(context.db, input),
    proposeProductMatch: (context, input) =>
      proposeProductMatch(context.db, input),
    mergeProductMatch: (context, input) => mergeProductMatch(context, input),
  },
);
