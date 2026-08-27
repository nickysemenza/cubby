import { recommendations, relatedness } from "~/lib/recommendations.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
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

export const relatednessHandlers = implementOperationDomain(relatedness, {
  product: {
    readPolicy: "strong",
    run: (context, input) => getProductRelatednessWorkflow(context.db, input),
  },
});

export const recommendationsHandlers = implementOperationDomain(
  recommendations,
  {
    placement: {
      readPolicy: "strong",
      run: (context, input) =>
        getPlacementRecommendationWorkflow(context.db, input),
    },
    product: {
      readPolicy: "strong",
      run: (context, input) =>
        getProductRecommendationWorkflow(context.db, input),
    },
    duplicateProduct: {
      readPolicy: "strong",
      run: (context, input) =>
        getDuplicateProductRecommendationWorkflow(context.db, input),
    },
    tagPropagation: {
      readPolicy: "strong",
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
