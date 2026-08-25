import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import * as workflow from "~/server/workflows/ingredient.server";

export const ingredientGetByName = (o: {
  data: z.input<typeof workflow.ingredientNameFilterInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.getByName",
    type: "query",
    input: o.data,
    inputSchema: workflow.ingredientNameFilterInput,
    outputSchema: workflow.ingredientWithFoodOut.nullable(),
    request: o.request,
    run: (c, i) => workflow.getByNameWorkflow(c.db, c.usdaClient, i),
  });
export const ingredientMatchNames = (o: {
  data: z.input<typeof workflow.ingredientNamesInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.matchNames",
    type: "query",
    input: o.data,
    inputSchema: workflow.ingredientNamesInput,
    outputSchema: workflow.ingredientMatchesOut,
    request: o.request,
    run: (c, i) => workflow.matchNamesWorkflow(c.db, i),
  });
export const ingredientGetManyByIDs = (o: {
  data: z.input<typeof workflow.ingredientIdsInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.getManyByIDs",
    type: "query",
    input: o.data,
    inputSchema: workflow.ingredientIdsInput,
    outputSchema: workflow.ingredientWithFoodLeanListOut,
    request: o.request,
    run: (c, i) => workflow.getManyByIDsWorkflow(c.db, c.usdaClient, i),
  });
export const ingredientRecipeUsages = (o: {
  data: z.input<typeof workflow.ingredientIdInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.recipeUsages",
    type: "query",
    input: o.data,
    inputSchema: workflow.ingredientIdInput,
    outputSchema: workflow.ingredientRecipeUsagesOut,
    request: o.request,
    run: (c, i) => workflow.recipeUsagesWorkflow(c.db, i),
  });
export const ingredientResolveOrCreate = (o: {
  data: z.input<typeof workflow.ingredientResolvableNamesInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.resolveOrCreate",
    type: "mutation",
    input: o.data,
    inputSchema: workflow.ingredientResolvableNamesInput,
    outputSchema: workflow.ingredientResolveOrCreateOut,
    request: o.request,
    run: (c, i) => workflow.resolveOrCreateWorkflow(c.db, i),
  });
export const ingredientEnrichmentWorkbench = (o: {
  data: z.input<typeof workflow.enrichmentWorkbenchInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.enrichmentWorkbench",
    type: "query",
    input: o.data,
    inputSchema: workflow.enrichmentWorkbenchInput,
    outputSchema: workflow.enrichmentRowsOut,
    request: o.request,
    run: (c, i) => workflow.enrichmentWorkbenchWorkflow(c.db, c.usdaClient, i),
  });
export const ingredientMerge = (o: {
  data: z.input<typeof workflow.ingredientMergeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "ingredient.merge",
    type: "mutation",
    input: o.data,
    inputSchema: workflow.ingredientMergeInput,
    outputSchema: z.object({
      ingredient: workflow.ingredientOut,
      mergeSummary: workflow.ingredientMergeOut.shape.mergeSummary,
      sideEffects: workflow.mutationSideEffectsSchema,
    }),
    request: o.request,
    run: (c, i) => workflow.mergeWorkflow(c, i),
  });
