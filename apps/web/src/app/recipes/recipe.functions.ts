import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import { equivalenceReportSchema } from "@cubby/schemas/equivalences";
import {
  attachCookbookRecipePhotoInput,
  attachCookbookRecipePhotoOut,
  chunkRequestInput,
  chunkResponseOut,
  cookbookDiffInput,
  cookbookDiffOut,
  cookbookIdInput,
  cookbookIdOut,
  cookbookImportEventSchema,
  cookbookReprocessEventSchema,
  cookbookSourceOut,
  deleteCookbookOut,
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

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
  subscription,
} from "~/integrations/tanstack-query/operation-catalog";

export const recipe = defineOperationDomain("recipe", {
  getManyByIDs: query({
    input: recipeIdsInput,
    output: recipeGraphListOut,
    tags: [["recipe"]],
  }),
  getAllTags: query({
    input: z.undefined(),
    output: recipeTagsOut,
    tags: [["recipe", "tags"]],
  }),
  duplicate: mutation({
    input: recipeIdInput,
    output: recipeWithSideEffectsOut,
    invalidates: ripple.recipeList,
  }),
  getIngredientCooccurrence: query({
    input: recipeCooccurrenceInput,
    output: ingredientCooccurrenceSchema,
    tags: [["recipe", "cooccurrence"]],
  }),
  getDependencyGraph: query({
    input: recipeCookbookScopeInput,
    output: recipeDependencyGraphSchema,
    tags: [["recipe", "dependencyGraph"]],
  }),
  getIngredientUsage: query({
    input: recipeCookbookScopeInput,
    output: ingredientUsageSchema,
    tags: [["recipe", "ingredientUsage"]],
  }),
  recomputeOne: mutation({
    input: recipeIdInput,
    output: recipeRecomputeAllOut,
    invalidates: ripple.recipe,
  }),
  dryRunRecomputeTotals: query({
    input: z.undefined(),
    output: recipeDryRunRecomputeTotalsOut,
    tags: [["recipe", "dryRun"]],
  }),
  explainCosting: query({
    input: recipeIdInput,
    output: recipeCostingExplain,
    tags: [["recipe", "costing"]],
  }),
  getFlow: query({
    input: recipeFlowGetInputSchema,
    output: recipeFlowStateSchema,
    tags: [["recipe", "flow"]],
  }),
  generateFlow: mutation({
    input: recipeFlowGenerateInputSchema,
    output: recipeFlowArtifactSchema,
    // The whole `recipe` prefix, not just the flow query: that is what the
    // legacy call site produced (its two-level key collapsed to the `["recipe"]`
    // root), and a generated flow can restate step order the costing and
    // dependency views read.
    invalidates: ripple.recipe,
  }),
  harvestEquivalences: query({
    input: z.undefined(),
    output: equivalenceReportSchema,
    tags: [["recipe", "equivalences"]],
    cache: "stable",
  }),
  scrape: mutation({
    input: scrapeRecipeInput,
    output: importRecipeSchema,
    invalidates: ripple.none,
  }),
  parseHtml: mutation({
    input: parseRecipeHtmlInput,
    output: importRecipeSchema,
    invalidates: ripple.none,
  }),
  upsertCookbook: mutation({
    input: upsertCookbookInput,
    output: cookbookIdOut,
    invalidates: ripple.cookbook,
  }),
  getCookbookSource: query({
    input: cookbookIdInput,
    output: cookbookSourceOut,
    tags: [["cookbook", "source"]],
  }),
  getCookbookDiff: query({
    input: cookbookDiffInput,
    output: cookbookDiffOut,
    tags: [["cookbook", "diff"]],
  }),
  previewNotionSync: query({
    input: z.undefined(),
    output: notionPreviewOut,
    tags: [["recipe", "notionPreview"]],
  }),
  setCookbookProduct: mutation({
    input: setCookbookProductInput,
    output: cookbookSummary,
    invalidates: ripple.cookbookProductLink,
  }),
  deleteCookbook: mutation({
    input: cookbookIdInput,
    output: deleteCookbookOut,
    invalidates: ripple.recipeCookbook,
  }),
  extractCookbookChunk: mutation({
    input: chunkRequestInput,
    output: chunkResponseOut,
    invalidates: ripple.none,
  }),
  attachCookbookRecipePhoto: mutation({
    input: attachCookbookRecipePhotoInput,
    output: attachCookbookRecipePhotoOut,
    invalidates: ripple.recipe,
  }),
});

export const suggestions = defineOperationDomain("suggestions", {
  getRecipeAvailability: query({
    input: recipeAvailabilityInput,
    output: recipeAvailabilityOut,
    tags: [["recipe", "availability"]],
  }),
  getMakeable: query({
    input: makeableRecipesInput,
    output: makeableRecipesOut,
    tags: [["recipe", "makeable"]],
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
      batchId: z.string().nullable(),
    }),
  }),
]);
export const recipeStreams = defineOperationDomain("recipe", {
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

export const openRecipeRecomputeAllStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeAllDurable.open(undefined, { signal });
export const openRecipeRecomputeStaleStream = (signal?: AbortSignal) =>
  recipeStreams.recomputeStaleDurable.open(undefined, { signal });
