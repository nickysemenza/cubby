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

export const recipeContract = defineContract(
  "recipe",
  {
    getManyByIDs: query({
      note: "entity_read.get per id, or entity_read.list with an ids filter on recipes",
      input: recipeIdsInput,
      output: recipeGraphListOut,
      cache: { tags: [["recipe"]] },
    }),
    duplicate: mutation({
      note: "entity_read.get the recipe, then entity.create the copy",
      command: { label: "Duplicate recipe", confirmation: null },
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
      exposure: "capability",
      description:
        "Recompute one recipe’s derived totals from its current ingredients and mappings. This writes derived values; inspect recipe.costing_explanation afterward.",
      input: recipeIdInput,
      output: recipeRecomputeAllOut,
      invalidates: ["recipe"],
    }),
    // Reads that drive imports or delegate to modules owning a strong database.
    dryRunRecomputeTotals: query({
      exposure: "capability",
      description:
        "Preview recipes whose derived totals would change under the current calculation rules. This is read-only; use recompute_one only for the reviewed recipe.",
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
      command: { label: "Generate walkthrough", confirmation: null },
      input: recipeFlowGenerateInputSchema,
      output: recipeFlowArtifactSchema,
      invalidates: ["recipe"],
    }),
    harvestEquivalences: query({
      exposure: "capability",
      description:
        "Read candidate ingredient equivalences harvested from recipe data. Treat these as leads and review the source before changing an Ingredient.",
      input: z.undefined(),
      output: equivalenceReportSchema,
      cache: { tags: [["recipe", "equivalences"]], profile: "stable" },
    }),
    scrape: mutation({
      input: scrapeRecipeInput,
      output: importRecipeSchema,
      invalidates: [],
    }),
    // Agent-facing (MCP `recipe_insights`, `recipe_import`).
    /** Nutrient totals scaled to a serving count, with mapped-line coverage. */
    nutrition: query({
      exposure: "capability",
      description:
        "Recipe nutrient totals scaled to a requested serving count, plus mapped-line coverage and compact reasons for unmapped lines. Refuses a recipe with no effective serving basis instead of guessing.",
      input: recipeNutritionInput,
      output: recipeNutritionOut,
    }),
    /** `explainCosting` trimmed to the per-line diagnostics unless `detail: "full"`. */
    costingExplanation: query({
      exposure: "capability",
      description:
        'A recipe\'s cost/calorie totals with per-ingredient diagnostics. `detail: "lines"` (default) drops the two full nutrient-totals blocks and the drift record and returns only the per-line diagnostics plus a cost/kcal coverage headline — use it when hunting the uncovered line, not the number.',
      readPolicy: "strong",
      input: z.object({
        id: recipeShortcode,
        detail: recipeCostingExplainDetail.default("lines"),
      }),
      output: recipeCostingExplainMcpOut,
    }),
    tags: query({
      exposure: "capability",
      description: "Every distinct recipe tag in use.",
      input: z.undefined(),
      output: recipeTagsOut,
    }),
    /** Parse a recipe URL into structured form without saving it. */
    scrapeUrl: query({
      exposure: "capability",
      description:
        "Parse a recipe from a URL into structured form WITHOUT saving it; recipe_insights.import_from_url saves.",
      openWorld: true,
      input: z.object({ url: scrapeRecipeInput }),
      output: scrapeRecipeMcpOut,
      cache: { tags: [] },
    }),
    importFromUrl: mutation({
      exposure: "capability",
      description:
        "Scrape a recipe from a URL and save it in one step; returns the new recipe's shortcode and `lineCoverage` (per line, which of price/weight/nutrients are still missing). recipe_insights_read.scrape_url parses without saving.",
      openWorld: true,
      input: z.object({ url: scrapeRecipeInput }),
      output: recipeImportWriteOut,
      invalidates: ["recipe"],
    }),
    createFromText: mutation({
      exposure: "capability",
      description:
        "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs — the path for a pasted prep sheet. Use entity.create(recipe) when you already have ingredient ids. Also returns `lineCoverage`.",
      input: mcpRecipeCreateFromTextInput,
      output: recipeImportWriteOut,
      invalidates: ["recipe"],
    }),
    /** Change one ingredient line without resending the recipe's sections. */
    patchLine: mutation({
      exposure: "capability",
      description:
        "Change one recipe ingredient line — its amounts, the ingredient or sub-recipe it points at, or its source text/modifier — without resending the recipe's sections. The line keeps its position and every other line and instruction is left as-is. `lineId` comes from recipe_insights_read.costing_explanation's per-line diagnostics or recipe_insights_read.recipe_usages's usages. Also returns the recipe's refreshed `lineCoverage`.",
      input: recipeLinePatchInput,
      output: recipeLinePatchOut,
      invalidates: ["recipe"],
    }),
    /**
     * `reprocessCookbook` for a client with no stream, one bounded window per call (the server
     * caps it): the same workflow, finalized per window, answered with where to continue.
     */
    reprocessCookbookOnce: mutation({
      exposure: "view",
      note: "The stream-less chunking of reprocessCookbook for the Apple app",
      input: cookbookReprocessChunkInput,
      output: cookbookReprocessOnceOut,
      invalidates: ["recipe", "cookbook"],
    }),
    /** `importCookbookStream` for one capped chunk of source recipes, answered with its counts. */
    importCookbookRecipesOnce: mutation({
      exposure: "view",
      note: "The stream-less chunking of importCookbookStream for the Apple app",
      input: cookbookImportChunkInput,
      output: cookbookImportOnceOut,
      invalidates: ["recipe", "cookbook"],
    }),
    /** Re-parse one stored line with the current parser and write what changed. */
    reparseLine: mutation({
      exposure: "capability",
      note: "Parser-upgrade repair; agents edit lines through recipe_insights.patch_line",
      description:
        "Reparse one recipe ingredient line after a parser upgrade or source correction. This changes the saved line; use recipe.patch_line for ordinary member edits.",
      command: { label: "Reparse line", confirmation: null },
      input: recipeLineReparseInput,
      output: recipeLineReparseOut,
      invalidates: ["recipe", "ingredient"],
    }),
    parseHtml: mutation({
      note: "The recipe form's paste-HTML parse; it saves nothing",
      input: parseRecipeHtmlInput,
      output: importRecipeSchema,
      invalidates: [],
    }),
    upsertCookbook: mutation({
      exposure: "internal",
      note: "In-browser cookbook extraction driver",
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
      note: "entity.update on the cookbook's product",
      input: setCookbookProductInput,
      output: cookbookSummary,
      invalidates: ["cookbookProductLink"],
    }),
    deleteCookbook: mutation({
      exposure: "capability",
      note: "Removes an imported cookbook with its recipes",
      description:
        "Delete an imported Cookbook and its associated recipes. Confirm the member intends to remove the whole import before calling this destructive action.",
      destructive: true,
      input: cookbookIdInput,
      output: deleteCookbookOut,
      invalidates: ["recipeCookbook"],
    }),
    // One gateway call of an in-browser cookbook extraction: the Rust driver
    // builds the request, the server signs and forwards it.
    forwardGatewayRequest: mutation({
      exposure: "internal",
      note: "In-browser cookbook extraction driver",
      input: gatewayForwardInput,
      output: gatewayForwardOut,
      invalidates: [],
    }),
    attachCookbookRecipePhoto: mutation({
      exposure: "internal",
      note: "In-browser cookbook extraction driver",
      input: attachCookbookRecipePhotoInput,
      output: attachCookbookRecipePhotoOut,
      invalidates: ["recipe"],
    }),
  },
  { exposure: "view", mcpToolGroup: "recipe_insights" },
);

export const recipeAvailabilityContract = defineContract(
  "recipeAvailability",
  {
    getRecipeAvailability: query({
      exposure: "view",
      note: "Agents read cookable recipes through recipe_insights_read.get_makeable",
      input: recipeAvailabilityInput,
      output: recipeAvailabilityOut,
      cache: { tags: [["recipe", "availability"]] },
    }),
    getMakeable: query({
      description:
        "Recipes ranked by planning coverage. Coverage distinguishes recorded inventory from ingredients marked usually on hand; quantity and blocked-sub-recipe warnings remain visible.",
      input: makeableRecipesInput,
      output: makeableRecipesOut,
      cache: { tags: [["recipe", "makeable"]] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "recipe_insights" },
);

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
