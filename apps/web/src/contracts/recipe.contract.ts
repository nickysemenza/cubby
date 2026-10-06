import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import { positiveAmount } from "@cubby/schemas/codec";
import { equivalenceReportSchema } from "@cubby/schemas/equivalences";
import {
  ingredientShortcode,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
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
  cookbookImportChunkInput,
  cookbookReprocessChunkInput,
  importCookbookStreamInput,
  importNotionSyncInput,
  importRecipeSchema,
  mcpRecipeCreateFromTextInput,
  notionImportEventSchema,
  notionPreviewOut,
  parseRecipeHtmlInput,
  recipeImportIdOut,
  recipeLineCoverageOut,
  scrapeRecipeInput,
  setCookbookProductInput,
  upsertCookbookInput,
} from "@cubby/schemas/import-recipe";
import { ingredientCooccurrenceSchema } from "@cubby/schemas/ingredient-cooccurrence";
import { ingredientUsageSchema } from "@cubby/schemas/ingredient-usage";
import {
  recipeCostingExplainDetail,
  recipeCostingExplainMcpOut,
  scrapeRecipeMcpOut,
} from "@cubby/schemas/mcp";
import { nutritionEstimate } from "@cubby/schemas/nutrition";
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
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

const recipeNutritionInput = z.object({
  recipeId: recipeShortcode,
  servings: z.number().positive(),
});
export const recipeNutritionOut = z.object({
  recipe: z.object({ id: recipeShortcode, name: z.string() }),
  recipeServings: z.number().positive(),
  requestedServings: z.number().positive(),
  nutrition: nutritionEstimate,
  coverage: z.object({
    totalLines: z.number().int().nonnegative(),
    mappedLines: z.number().int().nonnegative(),
    unmappedLines: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        reasons: z.array(z.enum(["weight", "nutrients"])),
      }),
    ),
  }),
});

export const recipeLinePatchFields = z
  .object({
    amounts: z
      .array(positiveAmount)
      .min(1)
      .optional()
      .describe('Replacement amounts, e.g. [{ value: 150, unit: "g" }]'),
    ingredientId: ingredientShortcode
      .optional()
      .describe("Point the line at this ingredient instead"),
    subRecipeId: recipeShortcode
      .optional()
      .describe("Point the line at this sub-recipe instead"),
    rawLine: z.string().optional().describe("Replacement source line text"),
    modifier: z.string().optional().describe("Replacement prep modifier"),
  })
  .refine((patch) => !(patch.ingredientId && patch.subRecipeId), {
    message: "Give ingredientId or subRecipeId, not both",
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: "Give at least one field to change",
  });

const recipeLinePatchInput = z.object({
  recipeId: recipeShortcode,
  // Declared exception: a recipe line has no shortcode; this is the row id
  // `recipe_insights` returns (using_ingredient usages[].lineId, costing
  // per-line diagnostics id).
  lineId: z.uuid(),
  patch: recipeLinePatchFields,
});

/** The saved recipe's id plus per-line costing gaps (MCP-only writes). */
const recipeImportWriteOut = recipeImportIdOut.extend({
  lineCoverage: recipeLineCoverageOut,
});

const recipeLinePatchOut = z.object({
  recipeId: recipeShortcode,
  lineCoverage: recipeLineCoverageOut,
  line: z.object({
    type: z.enum(["ingredient", "recipe"]),
    ingredientId: ingredientShortcode.nullable(),
    subRecipeId: recipeShortcode.nullable(),
    amounts: z.array(z.object({ value: z.number(), unit: z.string() })),
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
  }),
});

const cookbookReprocessOnceOut = z.object({
  reprocessed: z.number().int().nonnegative(),
  /** Where the next call starts; null when this window was the last. */
  nextOffset: z.number().int().nonnegative().nullable(),
});
const cookbookImportOnceOut = z.object({
  imported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** The raw reason each failed source recipe gave. */
  failures: z.array(
    z.object({ sourceRecipeId: z.string(), error: z.string() }),
  ),
  /** Source recipes the book still does not hold. */
  remaining: z.number().int().nonnegative(),
});

const recipeLineReparseInput = z.object({
  recipeId: recipeShortcode,
  // Declared exception: a recipe line has no shortcode (see `recipeLinePatchInput`).
  lineId: z.uuid(),
});
const recipeLineReparseOut = z.object({
  recipeId: recipeShortcode,
  status: z.enum(["updated", "unchanged"]),
  /** The axes written, in the order the parser reports drift. */
  changed: z.array(z.enum(["amount", "modifier", "name"])),
});

export const recipeContract = defineContract("recipe", {
  getManyByIDs: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "list"],
      note: "entity_read.get per id, or entity_read.list with an ids filter on recipes",
    },
    input: recipeIdsInput,
    output: recipeGraphListOut,
    cache: { tags: [["recipe"]] },
  }),
  duplicate: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "create"],
      note: "entity_read.get the recipe, then entity.create the copy",
    },
    input: recipeIdInput,
    output: recipeWithSideEffectsOut,
    invalidates: ["recipeList"],
  }),
  getIngredientCooccurrence: query({
    mcp: { omit: "client_view" },
    input: recipeCooccurrenceInput,
    output: ingredientCooccurrenceSchema,
    cache: { tags: [["recipe", "cooccurrence"]] },
  }),
  getDependencyGraph: query({
    mcp: { omit: "client_view" },
    input: recipeCookbookScopeInput,
    output: recipeDependencyGraphSchema,
    cache: { tags: [["recipe", "dependencyGraph"]] },
  }),
  getIngredientUsage: query({
    mcp: { omit: "client_view" },
    native: "Cookbook contents",
    input: recipeCookbookScopeInput,
    output: ingredientUsageSchema,
    cache: { tags: [["recipe", "ingredientUsage"]] },
  }),
  recomputeOne: mutation({
    mcp: { omit: "operator_maintenance" },
    input: recipeIdInput,
    output: recipeRecomputeAllOut,
    invalidates: ["recipe"],
  }),
  // Reads that drive imports or delegate to modules owning a strong database.
  dryRunRecomputeTotals: query({
    mcp: { omit: "operator_maintenance" },
    readPolicy: "strong",
    input: z.undefined(),
    output: recipeDryRunRecomputeTotalsOut,
    cache: { tags: [["recipe", "dryRun"]] },
  }),
  explainCosting: query({
    mcp: { omit: "agent_twin", twin: "recipe.costingExplanation" },
    readPolicy: "strong",
    input: recipeIdInput,
    output: recipeCostingExplain,
    cache: { tags: [["recipe", "costing"]] },
  }),
  getFlow: query({
    mcp: { omit: "client_view" },
    input: recipeFlowGetInputSchema,
    output: recipeFlowStateSchema,
    cache: { tags: [["recipe", "flow"]] },
  }),
  generateFlow: mutation({
    mcp: { omit: "model_assist" },
    native: "Generate a recipe's AI walkthrough from its report",
    input: recipeFlowGenerateInputSchema,
    output: recipeFlowArtifactSchema,
    invalidates: ["recipe"],
  }),
  harvestEquivalences: query({
    mcp: { omit: "operator_maintenance" },
    input: z.undefined(),
    output: equivalenceReportSchema,
    cache: { tags: [["recipe", "equivalences"]], profile: "stable" },
  }),
  scrape: mutation({
    mcp: { omit: "agent_twin", twin: "recipe.scrapeUrl" },
    input: scrapeRecipeInput,
    output: importRecipeSchema,
    invalidates: [],
  }),
  // Agent-facing (MCP `recipe_insights`, `recipe_import`): off the HTTP API.
  /** Nutrient totals scaled to a serving count, with mapped-line coverage. */
  nutrition: query({
    http: false,
    input: recipeNutritionInput,
    output: recipeNutritionOut,
  }),
  /** `explainCosting` trimmed to the per-line diagnostics unless `detail: "full"`. */
  costingExplanation: query({
    http: false,
    readPolicy: "strong",
    input: z.object({
      id: recipeShortcode,
      detail: recipeCostingExplainDetail.default("lines"),
    }),
    output: recipeCostingExplainMcpOut,
  }),
  tags: query({
    http: false,
    input: z.undefined(),
    output: recipeTagsOut,
  }),
  /** Parse a recipe URL into structured form without saving it. */
  scrapeUrl: query({
    http: false,
    input: z.object({ url: scrapeRecipeInput }),
    output: scrapeRecipeMcpOut,
    cache: { tags: [] },
  }),
  importFromUrl: mutation({
    http: false,
    input: z.object({ url: scrapeRecipeInput }),
    output: recipeImportWriteOut,
    invalidates: ["recipe"],
  }),
  createFromText: mutation({
    http: false,
    input: mcpRecipeCreateFromTextInput,
    output: recipeImportWriteOut,
    invalidates: ["recipe"],
  }),
  /** Change one ingredient line without resending the recipe's sections. */
  patchLine: mutation({
    http: false,
    input: recipeLinePatchInput,
    output: recipeLinePatchOut,
    invalidates: ["recipe"],
  }),
  /**
   * `reprocessCookbook` for a client with no stream, one bounded window per call (the server
   * caps it): the same workflow, finalized per window, answered with where to continue.
   */
  reprocessCookbookOnce: mutation({
    mcp: {
      omit: "device_protocol",
      note: "The stream-less chunking of reprocessCookbook for the Apple app",
    },
    native: "Reprocess a cookbook from its report command",
    input: cookbookReprocessChunkInput,
    output: cookbookReprocessOnceOut,
    invalidates: ["recipe", "cookbook"],
  }),
  /** `importCookbookStream` for one capped chunk of source recipes, answered with its counts. */
  importCookbookRecipesOnce: mutation({
    mcp: {
      omit: "device_protocol",
      note: "The stream-less chunking of importCookbookStream for the Apple app",
    },
    native: "Add source recipes to a cookbook from its report command",
    input: cookbookImportChunkInput,
    output: cookbookImportOnceOut,
    invalidates: ["recipe", "cookbook"],
  }),
  /** Re-parse one stored line with the current parser and write what changed. */
  reparseLine: mutation({
    mcp: {
      omit: "operator_maintenance",
      note: "Parser-upgrade repair; agents edit lines through recipe_import.patch_line",
    },
    native: "Re-parse a recipe line from a report row",
    input: recipeLineReparseInput,
    output: recipeLineReparseOut,
    invalidates: ["recipe", "ingredient"],
  }),
  parseHtml: mutation({
    mcp: {
      omit: "client_view",
      note: "The recipe form's paste-HTML parse; it saves nothing",
    },
    input: parseRecipeHtmlInput,
    output: importRecipeSchema,
    invalidates: [],
  }),
  upsertCookbook: mutation({
    mcp: {
      omit: "device_protocol",
      note: "In-browser cookbook extraction driver",
    },
    input: upsertCookbookInput,
    output: cookbookIdOut,
    invalidates: ["cookbook"],
  }),
  getCookbookSource: query({
    mcp: { omit: "client_view" },
    readPolicy: "strong",
    input: cookbookIdInput,
    output: cookbookSourceOut,
    cache: { tags: [["cookbook", "source"]] },
  }),
  getCookbookDiff: query({
    mcp: { omit: "client_view" },
    readPolicy: "strong",
    input: cookbookDiffInput,
    output: cookbookDiffOut,
    cache: { tags: [["cookbook", "diff"]] },
  }),
  previewNotionSync: query({
    mcp: { omit: "client_view" },
    readPolicy: "strong",
    input: z.undefined(),
    output: notionPreviewOut,
    cache: { tags: [["recipe", "notionPreview"]] },
  }),
  setCookbookProduct: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["update"],
      note: "entity.update on the cookbook's product",
    },
    input: setCookbookProductInput,
    output: cookbookSummary,
    invalidates: ["cookbookProductLink"],
  }),
  deleteCookbook: mutation({
    mcp: {
      omit: "operator_maintenance",
      note: "Removes an imported cookbook with its recipes",
    },
    input: cookbookIdInput,
    output: deleteCookbookOut,
    invalidates: ["recipeCookbook"],
  }),
  // One gateway call of an in-browser cookbook extraction: the Rust driver
  // builds the request, the server signs and forwards it.
  forwardGatewayRequest: mutation({
    mcp: {
      omit: "device_protocol",
      note: "In-browser cookbook extraction driver",
    },
    input: gatewayForwardInput,
    output: gatewayForwardOut,
    invalidates: [],
  }),
  attachCookbookRecipePhoto: mutation({
    mcp: {
      omit: "device_protocol",
      note: "In-browser cookbook extraction driver",
    },
    input: attachCookbookRecipePhotoInput,
    output: attachCookbookRecipePhotoOut,
    invalidates: ["recipe"],
  }),
});

export const suggestionsContract = defineContract("suggestions", {
  getRecipeAvailability: query({
    mcp: {
      omit: "client_view",
      note: "Agents read cookable recipes through recipe_insights.cookable",
    },
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
