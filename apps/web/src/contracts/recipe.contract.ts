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
    cache: { tags: [["recipe"]] },
  }),
  duplicate: mutation({
    input: recipeIdInput,
    output: recipeWithSideEffectsOut,
    invalidates: ["recipeList"],
  }),
  getIngredientCooccurrence: query({
    input: recipeCooccurrenceInput,
    output: ingredientCooccurrenceSchema,
    cache: { tags: [["recipe", "cooccurrence"]] },
  }),
  getDependencyGraph: query({
    input: recipeCookbookScopeInput,
    output: recipeDependencyGraphSchema,
    cache: { tags: [["recipe", "dependencyGraph"]] },
  }),
  getIngredientUsage: query({
    input: recipeCookbookScopeInput,
    output: ingredientUsageSchema,
    cache: { tags: [["recipe", "ingredientUsage"]] },
  }),
  recomputeOne: mutation({
    input: recipeIdInput,
    output: recipeRecomputeAllOut,
    invalidates: ["recipe"],
  }),
  // Reads that drive imports or delegate to modules owning a strong database.
  dryRunRecomputeTotals: query({
    readPolicy: "strong",
    input: z.undefined(),
    output: recipeDryRunRecomputeTotalsOut,
    cache: { tags: [["recipe", "dryRun"]] },
  }),
  explainCosting: query({
    readPolicy: "strong",
    input: recipeIdInput,
    output: recipeCostingExplain,
    cache: { tags: [["recipe", "costing"]] },
  }),
  getFlow: query({
    input: recipeFlowGetInputSchema,
    output: recipeFlowStateSchema,
    cache: { tags: [["recipe", "flow"]] },
  }),
  generateFlow: mutation({
    input: recipeFlowGenerateInputSchema,
    output: recipeFlowArtifactSchema,
    invalidates: ["recipe"],
  }),
  harvestEquivalences: query({
    input: z.undefined(),
    output: equivalenceReportSchema,
    cache: { tags: [["recipe", "equivalences"]], profile: "stable" },
  }),
  scrape: mutation({
    input: scrapeRecipeInput,
    output: importRecipeSchema,
    invalidates: [],
  }),
  parseHtml: mutation({
    input: parseRecipeHtmlInput,
    output: importRecipeSchema,
    invalidates: [],
  }),
  upsertCookbook: mutation({
    input: upsertCookbookInput,
    output: cookbookIdOut,
    invalidates: ["cookbook"],
  }),
  getCookbookSource: query({
    readPolicy: "strong",
    input: cookbookIdInput,
    output: cookbookSourceOut,
    cache: { tags: [["cookbook", "source"]] },
  }),
  getCookbookDiff: query({
    readPolicy: "strong",
    input: cookbookDiffInput,
    output: cookbookDiffOut,
    cache: { tags: [["cookbook", "diff"]] },
  }),
  previewNotionSync: query({
    readPolicy: "strong",
    input: z.undefined(),
    output: notionPreviewOut,
    cache: { tags: [["recipe", "notionPreview"]] },
  }),
  setCookbookProduct: mutation({
    input: setCookbookProductInput,
    output: cookbookSummary,
    invalidates: ["cookbookProductLink"],
  }),
  deleteCookbook: mutation({
    input: cookbookIdInput,
    output: deleteCookbookOut,
    invalidates: ["recipeCookbook"],
  }),
  // One gateway call of an in-browser cookbook extraction: the Rust driver
  // builds the request, the server signs and forwards it.
  forwardGatewayRequest: mutation({
    input: gatewayForwardInput,
    output: gatewayForwardOut,
    invalidates: [],
  }),
  attachCookbookRecipePhoto: mutation({
    input: attachCookbookRecipePhotoInput,
    output: attachCookbookRecipePhotoOut,
    invalidates: ["recipe"],
  }),
});

export const suggestionsContract = defineContract("suggestions", {
  getRecipeAvailability: query({
    input: recipeAvailabilityInput,
    output: recipeAvailabilityOut,
    cache: { tags: [["recipe", "availability"]] },
  }),
  getMakeable: query({
    input: makeableRecipesInput,
    output: makeableRecipesOut,
    cache: { tags: [["recipe", "makeable"]] },
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
