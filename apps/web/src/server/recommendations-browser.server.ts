import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  dismissDuplicateProductRecommendationWorkflow,
  dismissProductRecommendationWorkflow,
  dismissTagPropagationWorkflow,
  getDuplicateProductRecommendationWorkflow,
  getPlacementRecommendationWorkflow,
  getProductRecommendationWorkflow,
  getProductRelatednessWorkflow,
  getTagPropagationRecommendationWorkflow,
  recommendationWorkflowSchemas,
} from "~/server/workflows/recommendations.server";

const schemas = recommendationWorkflowSchemas;
export const getProductRelatednessForBrowser = (o: {
  data: z.input<typeof schemas.relatedness.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "relatedness.product",
    type: "query",
    input: o.data,
    inputSchema: schemas.relatedness.input,
    outputSchema: schemas.relatedness.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => getProductRelatednessWorkflow(c.db, input),
  });
export const getPlacementRecommendationForBrowser = (o: {
  data: z.input<typeof schemas.placement.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.placement",
    type: "query",
    input: o.data,
    inputSchema: schemas.placement.input,
    outputSchema: schemas.placement.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => getPlacementRecommendationWorkflow(c.db, input),
  });
export const getProductRecommendationForBrowser = (o: {
  data: z.input<typeof schemas.product.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.product",
    type: "query",
    input: o.data,
    inputSchema: schemas.product.input,
    outputSchema: schemas.product.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => getProductRecommendationWorkflow(c.db, input),
  });
export const getDuplicateProductRecommendationForBrowser = (o: {
  data: z.input<typeof schemas.duplicateProduct.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.duplicateProduct",
    type: "query",
    input: o.data,
    inputSchema: schemas.duplicateProduct.input,
    outputSchema: schemas.duplicateProduct.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => getDuplicateProductRecommendationWorkflow(c.db, input),
  });
export const dismissDuplicateProductRecommendationForBrowser = (o: {
  data: z.input<typeof schemas.dismissDuplicateProduct.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.dismissDuplicateProduct",
    type: "mutation",
    input: o.data,
    inputSchema: schemas.dismissDuplicateProduct.input,
    outputSchema: schemas.dismissDuplicateProduct.output,
    request: o.request,
    run: (c, input) =>
      dismissDuplicateProductRecommendationWorkflow(c.db, input),
  });
export const getTagPropagationRecommendationForBrowser = (o: {
  data: z.input<typeof schemas.tagPropagation.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.tagPropagation",
    type: "query",
    input: o.data,
    inputSchema: schemas.tagPropagation.input,
    outputSchema: schemas.tagPropagation.output,
    request: o.request,
    readPolicy: "strong",
    run: (c, input) => getTagPropagationRecommendationWorkflow(c.db, input),
  });
export const dismissTagPropagationForBrowser = (o: {
  data: z.input<typeof schemas.dismissTagPropagation.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.dismissTagPropagation",
    type: "mutation",
    input: o.data,
    inputSchema: schemas.dismissTagPropagation.input,
    outputSchema: schemas.dismissTagPropagation.output,
    request: o.request,
    run: (c, input) => dismissTagPropagationWorkflow(c.db, input),
  });
export const dismissProductRecommendationForBrowser = (o: {
  data: z.input<typeof schemas.dismissProduct.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "recommendations.dismissProduct",
    type: "mutation",
    input: o.data,
    inputSchema: schemas.dismissProduct.input,
    outputSchema: schemas.dismissProduct.output,
    request: o.request,
    run: (c, input) => dismissProductRecommendationWorkflow(c.db, input),
  });
