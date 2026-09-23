import {
  recipeContract as recipeDomainContract,
  recipeStreamsContract,
  suggestionsContract,
} from "~/contracts/recipe.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { ensureRun } from "~/server/runs/ensure-run";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import * as imports from "~/server/workflows/recipe-import.server";
import * as recipe from "~/server/workflows/recipe.server";

export const recipeHandlers = implementOperationDomain(recipeDomainContract, {
  getManyByIDs: (context, input) =>
    recipe.getManyByIDsWorkflow(context.db, input),
  getAllTags: (context) => recipe.getAllTagsWorkflow(context.db),
  duplicate: (context, input) => recipe.duplicateWorkflow(context, input),
  getIngredientCooccurrence: (context, input) =>
    recipe.getIngredientCooccurrenceWorkflow(context.db, input),
  getDependencyGraph: (context, input) =>
    recipe.getDependencyGraphWorkflow(context.db, input),
  getIngredientUsage: (context, input) =>
    recipe.getIngredientUsageWorkflow(context.db, input),
  recomputeOne: (context, input) =>
    recipe.recomputeOneWorkflow(
      context.db,
      input,
      context.services.recipeCosting,
    ),
  dryRunRecomputeTotals: (context) =>
    recipe.dryRunRecomputeTotalsWorkflow(context.services.recipeCosting),
  explainCosting: (context, input) =>
    recipe.explainCostingWorkflow(
      context.db,
      input,
      context.services.recipeCosting,
    ),
  getFlow: (context, input) => recipe.getFlowWorkflow(context.db, input),
  generateFlow: async (context, input) => {
    const runId = await ensureRun(context.db, context.actorContext, {
      purpose: "ai_action",
    });
    return recipe.generateFlowWorkflow({ db: context.db, runId }, input);
  },
  harvestEquivalences: (context) =>
    recipe.harvestEquivalencesWorkflow(context.db, context.usdaClient),
  scrape: (_context, input) => imports.scrapeWorkflow(input),
  parseHtml: async (_context, input) => imports.parseHtmlWorkflow(input),
  upsertCookbook: (context, input) =>
    imports.upsertCookbookWorkflow(context, input),
  getCookbookSource: (context, input) =>
    imports.getCookbookSourceWorkflow(context, input),
  getCookbookDiff: (context, input) =>
    imports.getCookbookDiffWorkflow(context, input),
  previewNotionSync: (context) => imports.previewNotionSyncWorkflow(context),
  setCookbookProduct: (context, input) =>
    imports.setCookbookProductWorkflow(context, input),
  deleteCookbook: (context, input) =>
    imports.deleteCookbookWorkflow(context, input),
  forwardGatewayRequest: (context, input) =>
    imports.forwardGatewayRequestWorkflow(context, input),
  attachCookbookRecipePhoto: (context, input) =>
    imports.attachCookbookRecipePhotoWorkflow(context, input),
});

export const suggestionsHandlers = implementOperationDomain(
  suggestionsContract,
  {
    getRecipeAvailability: (context, input) =>
      recipe.getRecipeAvailabilityWorkflow(
        input.recipeId,
        context.services.availability,
      ),
    getMakeable: (context, input) =>
      recipe.getMakeableWorkflow(
        context.db,
        input,
        context.services.availability,
      ),
  },
);

export const recipeStreamHandlers = implementSubscriptionDomain(
  recipeStreamsContract,
  {
    recomputeAllDurable: (context, _input, signal) =>
      recipe.recomputeAllDurableWorkflow(
        context.services.recipeCosting,
        signal,
      ),
    recomputeStaleDurable: (context, _input, signal) =>
      recipe.recomputeStaleDurableWorkflow(
        context.services.recipeCosting,
        signal,
      ),
    importCookbookStream: (context, input, signal) =>
      imports.importCookbookWorkflow(context, input, signal),
    importNotionSyncStream: (context, input, signal) =>
      imports.importNotionSyncWorkflow(context, input, signal),
    reprocessCookbook: (context, input, signal) =>
      imports.reprocessCookbookWorkflow(context, input, signal),
  },
);
