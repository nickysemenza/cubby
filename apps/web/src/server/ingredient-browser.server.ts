import { ingredientContract } from "~/contracts/ingredient.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import * as workflow from "~/server/workflows/ingredient.server";

export const ingredientHandlers = implementOperationDomain(ingredientContract, {
  getByName: (context, input) =>
    workflow.getByNameWorkflow(context.db, context.usdaClient, input),
  matchNames: (context, input) =>
    workflow.matchNamesWorkflow(context.db, input),
  getManyByIDs: (context, input) =>
    workflow.getManyByIDsWorkflow(context.db, context.usdaClient, input),
  recipeUsages: (context, input) =>
    workflow.recipeUsagesWorkflow(context.db, input),
  resolveOrCreate: (context, input) =>
    workflow.resolveOrCreateWorkflow(context.db, input),
  enrichmentWorkbench: (context, input) =>
    workflow.enrichmentWorkbenchWorkflow(context.db, context.usdaClient, input),
  merge: (context, input) => workflow.mergeWorkflow(context, input),
});
