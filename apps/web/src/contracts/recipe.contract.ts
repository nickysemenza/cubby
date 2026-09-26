import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import { equivalenceReportSchema } from "@cubby/schemas/equivalences";
import {
  attachCookbookRecipePhotoInput,
  attachCookbookRecipePhotoOut,
  cookbookDiffInput,
  cookbookDiffOut,
  cookbookIdInput,
  cookbookIdOut,
  cookbookImportEventSchema,
  cookbookReprocessEventSchema,
  cookbookSourceOut,
  deleteCookbookOut,
  gatewayForwardInput,
  gatewayForwardOut,
  importCookbookStreamInput,
  importNotionSyncInput,
  importRecipeSchema,
  notionImportEventSchema,
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
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

export const recipeContract = defineContract("recipe", {
  getManyByIDs: query({
    input: recipeIdsInput,
    output: recipeGraphListOut,
  }),
  duplicate: mutation({
    input: recipeIdInput,
    output: recipeWithSideEffectsOut,
  }),
  getIngredientCooccurrence: query({
    input: recipeCooccurrenceInput,
    output: ingredientCooccurrenceSchema,
  }),
  getDependencyGraph: query({
    input: recipeCookbookScopeInput,
    output: recipeDependencyGraphSchema,
  }),
  getIngredientUsage: query({
    input: recipeCookbookScopeInput,
    output: ingredientUsageSchema,
  }),
  recomputeOne: mutation({
    input: recipeIdInput,
    output: recipeRecomputeAllOut,
  }),
  dryRunRecomputeTotals: query({
    input: z.undefined(),
    output: recipeDryRunRecomputeTotalsOut,
  }),
  explainCosting: query({
    input: recipeIdInput,
    output: recipeCostingExplain,
  }),
  getFlow: query({
    input: recipeFlowGetInputSchema,
    output: recipeFlowStateSchema,
  }),
  generateFlow: mutation({
    input: recipeFlowGenerateInputSchema,
    output: recipeFlowArtifactSchema,
  }),
  harvestEquivalences: query({
    input: z.undefined(),
    output: equivalenceReportSchema,
  }),
  scrape: mutation({
    input: scrapeRecipeInput,
    output: importRecipeSchema,
  }),
  parseHtml: mutation({
    input: parseRecipeHtmlInput,
    output: importRecipeSchema,
  }),
  upsertCookbook: mutation({
    input: upsertCookbookInput,
    output: cookbookIdOut,
  }),
  getCookbookSource: query({
    input: cookbookIdInput,
    output: cookbookSourceOut,
  }),
  getCookbookDiff: query({
    input: cookbookDiffInput,
    output: cookbookDiffOut,
  }),
  previewNotionSync: query({
    input: z.undefined(),
    output: notionPreviewOut,
  }),
  setCookbookProduct: mutation({
    input: setCookbookProductInput,
    output: cookbookSummary,
  }),
  deleteCookbook: mutation({
    input: cookbookIdInput,
    output: deleteCookbookOut,
  }),
  // One gateway call of an in-browser cookbook extraction: the Rust driver
  // builds the request, the server signs and forwards it.
  forwardGatewayRequest: mutation({
    input: gatewayForwardInput,
    output: gatewayForwardOut,
  }),
  attachCookbookRecipePhoto: mutation({
    input: attachCookbookRecipePhotoInput,
    output: attachCookbookRecipePhotoOut,
  }),
});

export const suggestionsContract = defineContract("suggestions", {
  getRecipeAvailability: query({
    input: recipeAvailabilityInput,
    output: recipeAvailabilityOut,
  }),
  getMakeable: query({
    input: makeableRecipesInput,
    output: makeableRecipesOut,
  }),
});

const recomputeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({
      enqueued: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  }),
]);
export const recipeStreamsContract = defineContract("recipe", {
  recomputeAllDurable: subscription({
    input: z.undefined(),
    event: recomputeEventSchema,
  }),
  recomputeStaleDurable: subscription({
    input: z.undefined(),
    event: recomputeEventSchema,
  }),
  importCookbookStream: subscription({
    input: importCookbookStreamInput,
    event: cookbookImportEventSchema,
  }),
  importNotionSyncStream: subscription({
    input: importNotionSyncInput,
    event: notionImportEventSchema,
  }),
  reprocessCookbook: subscription({
    input: cookbookIdInput,
    event: cookbookReprocessEventSchema,
  }),
});
