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
  /** Source recipes the book does not hold yet. */
  importableExtras: z.number().int().nonnegative(),
});
const cookbookImportOnceOut = z.object({
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** The raw reason each failed source recipe gave. */
  failures: z.array(
    z.object({ sourceRecipeId: z.string(), error: z.string() }),
  ),
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
    native: "Cookbook contents",
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
    native: "Generate a recipe's AI walkthrough from its report",
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
   * `reprocessCookbook` run to its end for a client with no stream: the same workflow, answered
   * once with its summary.
   */
  reprocessCookbookOnce: mutation({
    native: "Reprocess a cookbook from its report command",
    input: cookbookIdInput,
    output: cookbookReprocessOnceOut,
    invalidates: ["recipe", "cookbook"],
  }),
  /** `importCookbookStream` run to its end, answered once with its summary. */
  importCookbookRecipesOnce: mutation({
    native: "Add source recipes to a cookbook from its report command",
    input: importCookbookStreamInput,
    output: cookbookImportOnceOut,
    invalidates: ["recipe", "cookbook"],
  }),
  /** Re-parse one stored line with the current parser and write what changed. */
  reparseLine: mutation({
    native: "Re-parse a recipe line from a report row",
    input: recipeLineReparseInput,
    output: recipeLineReparseOut,
    invalidates: ["recipe", "ingredient"],
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
