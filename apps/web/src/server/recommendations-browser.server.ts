import {
  recommendationsContract,
  relatednessContract,
} from "~/contracts/recommendations.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getEntityRecommendations } from "~/server/services/entity-recommendations.service";
import {
  dismissDuplicateProductRecommendationWorkflow,
  dismissProductRecommendationWorkflow,
  dismissTagPropagationWorkflow,
  getDuplicateProductRecommendationWorkflow,
  getPlacementRecommendationWorkflow,
  getProductRecommendationWorkflow,
  getProductRelatednessWorkflow,
  getTagPropagationRecommendationWorkflow,
} from "~/server/workflows/recommendations.server";

export const relatednessHandlers = implementOperationDomain(
  relatednessContract,
  {
    product: {
      run: (context, input) => getProductRelatednessWorkflow(context.db, input),
    },
  },
);

export const recommendationsHandlers = implementOperationDomain(
  recommendationsContract,
  {
    forEntity: {
      run: (context, input) => getEntityRecommendations(context.db, input),
    },
    placement: {
      run: (context, input) =>
        getPlacementRecommendationWorkflow(context.db, input),
    },
    product: {
      run: (context, input) =>
        getProductRecommendationWorkflow(context.db, input),
    },
    duplicateProduct: {
      run: (context, input) =>
        getDuplicateProductRecommendationWorkflow(context.db, input),
    },
    tagPropagation: {
      run: (context, input) =>
        getTagPropagationRecommendationWorkflow(context.db, input),
    },
    dismissDuplicateProduct: (context, input) =>
      dismissDuplicateProductRecommendationWorkflow(context.db, input),
    dismissTagPropagation: (context, input) =>
      dismissTagPropagationWorkflow(context.db, input),
    dismissProduct: (context, input) =>
      dismissProductRecommendationWorkflow(context.db, input),
  },
);
