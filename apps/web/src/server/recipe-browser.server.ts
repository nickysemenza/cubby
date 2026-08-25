import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import { equivalenceReportSchema } from "@cubby/schemas/equivalences";
import {
  chunkRequestInput,
  chunkResponseOut,
  cookbookDiffInput,
  cookbookDiffOut,
  cookbookIdInput,
  cookbookIdOut,
  cookbookSourceOut,
  deleteCookbookOut,
  importRecipeSchema,
  notionPreviewOut,
  parseRecipeHtmlInput,
  scrapeRecipeInput,
  setCookbookProductInput,
  upsertCookbookInput,
} from "@cubby/schemas/import-recipe";
import { ingredientCooccurrenceSchema } from "@cubby/schemas/ingredient-cooccurrence";
import { ingredientUsageSchema } from "@cubby/schemas/ingredient-usage";
import {
  cookbookSummary,
  recipeCooccurrenceInput,
  recipeCookbookScopeInput,
  recipeDryRunRecomputeTotalsOut,
  recipeGraphListOut,
  recipeIdInput,
  recipeIdsInput,
  recipeRecomputeAllOut,
  recipeTagsOut,
  recipeWithSideEffectsOut,
} from "@cubby/schemas/recipe";
import { recipeDependencyGraphSchema } from "@cubby/schemas/recipe-dependency-graph";
import {
  recipeFlowArtifactSchema,
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
  recipeFlowStateSchema,
} from "@cubby/schemas/recipe-flow";
import { recipeCostingExplain } from "@cubby/schemas/recipe-shared";
import {
  makeableRecipesInput,
  makeableRecipesOut,
  recipeAvailabilityInput,
} from "@cubby/schemas/suggestions";
import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import * as recipe from "~/server/workflows/recipe.server";
import * as imports from "~/server/workflows/recipe-import.server";

type RequestArgs<T> = { data: T; request: StartOperationRequest };
const operation =
  <I extends z.ZodType, O>(options: {
    operation: string;
    type: "query" | "mutation";
    inputSchema: I;
    outputSchema: z.ZodType<O>;
    run: (
      context: Parameters<typeof runStartOperation<I, O>>[0] extends {
        run: infer R;
      }
        ? Parameters<Extract<R, (...args: never[]) => unknown>>[0]
        : never,
      input: z.output<I>,
    ) => Promise<unknown> | unknown;
  }) =>
  (args: RequestArgs<z.input<I>>) =>
    runStartOperation({
      ...options,
      input: args.data,
      request: args.request,
      run: async (context, input) => options.run(context as never, input),
    });

export const recipeGetMany = operation({
  operation: "recipe.getManyByIDs",
  type: "query",
  inputSchema: recipeIdsInput,
  outputSchema: recipeGraphListOut,
  run: (c, i) => recipe.getManyByIDsWorkflow(c.db, i),
});
export const recipeGetAllTags = operation({
  operation: "recipe.getAllTags",
  type: "query",
  inputSchema: z.undefined(),
  outputSchema: recipeTagsOut,
  run: (c) => recipe.getAllTagsWorkflow(c.db),
});
export const recipeDuplicate = operation({
  operation: "recipe.duplicate",
  type: "mutation",
  inputSchema: recipeIdInput,
  outputSchema: recipeWithSideEffectsOut,
  run: (c, i) => recipe.duplicateWorkflow(c, i),
});
export const recipeCooccurrence = operation({
  operation: "recipe.getIngredientCooccurrence",
  type: "query",
  inputSchema: recipeCooccurrenceInput,
  outputSchema: ingredientCooccurrenceSchema,
  run: (c, i) => recipe.getIngredientCooccurrenceWorkflow(c.db, i),
});
export const recipeDependencyGraph = operation({
  operation: "recipe.getDependencyGraph",
  type: "query",
  inputSchema: recipeCookbookScopeInput,
  outputSchema: recipeDependencyGraphSchema,
  run: (c, i) => recipe.getDependencyGraphWorkflow(c.db, i),
});
export const recipeIngredientUsage = operation({
  operation: "recipe.getIngredientUsage",
  type: "query",
  inputSchema: recipeCookbookScopeInput,
  outputSchema: ingredientUsageSchema,
  run: (c, i) => recipe.getIngredientUsageWorkflow(c.db, i),
});
export const recipeRecomputeOne = operation({
  operation: "recipe.recomputeOne",
  type: "mutation",
  inputSchema: recipeIdInput,
  outputSchema: recipeRecomputeAllOut,
  run: (c, i) => recipe.recomputeOneWorkflow(c.db, i, c.services.recipeCosting),
});
export const recipeDryRun = operation({
  operation: "recipe.dryRunRecomputeTotals",
  type: "query",
  inputSchema: z.undefined(),
  outputSchema: recipeDryRunRecomputeTotalsOut,
  run: (c) => recipe.dryRunRecomputeTotalsWorkflow(c.services.recipeCosting),
});
export const recipeExplainCosting = operation({
  operation: "recipe.explainCosting",
  type: "query",
  inputSchema: recipeIdInput,
  outputSchema: recipeCostingExplain,
  run: (c, i) =>
    recipe.explainCostingWorkflow(c.db, i, c.services.recipeCosting),
});
export const recipeGetFlow = operation({
  operation: "recipe.getFlow",
  type: "query",
  inputSchema: recipeFlowGetInputSchema,
  outputSchema: recipeFlowStateSchema,
  run: (c, i) => recipe.getFlowWorkflow(c.db, i),
});
export const recipeGenerateFlow = operation({
  operation: "recipe.generateFlow",
  type: "mutation",
  inputSchema: recipeFlowGenerateInputSchema,
  outputSchema: recipeFlowArtifactSchema,
  run: (c, i) => recipe.generateFlowWorkflow(c.db, i),
});
export const recipeHarvestEquivalences = operation({
  operation: "recipe.harvestEquivalences",
  type: "query",
  inputSchema: z.undefined(),
  outputSchema: equivalenceReportSchema,
  run: (c) => recipe.harvestEquivalencesWorkflow(c.db, c.usdaClient),
});
export const suggestionAvailability = operation({
  operation: "suggestions.getRecipeAvailability",
  type: "query",
  inputSchema: recipeAvailabilityInput,
  outputSchema: recipeAvailabilityOut,
  run: (c, i) =>
    recipe.getRecipeAvailabilityWorkflow(i.recipeId, c.services.availability),
});
export const suggestionMakeable = operation({
  operation: "suggestions.getMakeable",
  type: "query",
  inputSchema: makeableRecipesInput,
  outputSchema: makeableRecipesOut,
  run: (c, i) => recipe.getMakeableWorkflow(c.db, i, c.services.availability),
});

export const recipeScrape = operation({
  operation: "recipe.scrape",
  type: "mutation",
  inputSchema: scrapeRecipeInput,
  outputSchema: importRecipeSchema,
  run: (_c, i) => imports.scrapeWorkflow(i),
});
export const recipeParseHtml = operation({
  operation: "recipe.parseHtml",
  type: "mutation",
  inputSchema: parseRecipeHtmlInput,
  outputSchema: importRecipeSchema,
  run: (_c, i) => imports.parseHtmlWorkflow(i),
});
export const recipeUpsertCookbook = operation({
  operation: "recipe.upsertCookbook",
  type: "mutation",
  inputSchema: upsertCookbookInput,
  outputSchema: cookbookIdOut,
  run: (c, i) => imports.upsertCookbookWorkflow(c, i),
});
export const recipeCookbookSource = operation({
  operation: "recipe.getCookbookSource",
  type: "query",
  inputSchema: cookbookIdInput,
  outputSchema: cookbookSourceOut,
  run: (c, i) => imports.getCookbookSourceWorkflow(c, i),
});
export const recipeCookbookDiff = operation({
  operation: "recipe.getCookbookDiff",
  type: "query",
  inputSchema: cookbookDiffInput,
  outputSchema: cookbookDiffOut,
  run: (c, i) => imports.getCookbookDiffWorkflow(c, i),
});
export const recipePreviewNotion = operation({
  operation: "recipe.previewNotionSync",
  type: "query",
  inputSchema: z.undefined(),
  outputSchema: notionPreviewOut,
  run: (c) => imports.previewNotionSyncWorkflow(c),
});
export const recipeSetCookbookProduct = operation({
  operation: "recipe.setCookbookProduct",
  type: "mutation",
  inputSchema: setCookbookProductInput,
  outputSchema: cookbookSummary,
  run: (c, i) => imports.setCookbookProductWorkflow(c, i),
});
export const recipeDeleteCookbook = operation({
  operation: "recipe.deleteCookbook",
  type: "mutation",
  inputSchema: cookbookIdInput,
  outputSchema: deleteCookbookOut,
  run: (c, i) => imports.deleteCookbookWorkflow(c, i),
});
export const recipeExtractCookbookChunk = operation({
  operation: "recipe.extractCookbookChunk",
  type: "mutation",
  inputSchema: chunkRequestInput,
  outputSchema: chunkResponseOut,
  run: (c, i) => imports.extractCookbookChunkWorkflow(c, i),
});
