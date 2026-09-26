import {
  mcpRecipeCreateFromTextInput,
  recipeImportIdOut,
  scrapeRecipeInput,
} from "@cubby/schemas/import-recipe";
import {
  recipeAvailabilityMcpOut,
  recipeCostingExplainDetail,
  recipeCostingExplainMcpOut,
  recipesUsingIngredientOut,
  scrapeRecipeMcpOut,
} from "@cubby/schemas/mcp";
import { nutritionEstimate } from "@cubby/schemas/nutrition";
import type { RecipeCostingExplain } from "@cubby/schemas/recipe-shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
import { z } from "zod";

import { cookbookContract } from "~/contracts/cookbook.contract";
import { recipeContract } from "~/contracts/recipe.contract";
import { scaleTotals } from "~/lib/nutrition-estimates";
import { executeEntity } from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import { listCookbooks } from "~/server/repo/cookbook";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { recipeUsagesWorkflow } from "~/server/workflows/ingredient.server";
import {
  insertImportWorkflow,
  scrapeWorkflow,
} from "~/server/workflows/recipe-import.server";
import {
  explainCostingWorkflow,
  getAllTagsWorkflow,
  getMakeableWorkflow,
} from "~/server/workflows/recipe.server";

import { getEntityKernelContext } from "../kernel-context";
import {
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerMcpTool,
  registerRouterTool,
  slimRecipe,
  WRITE_CLOSED,
} from "./_shared";
import { fromContract, mcpItemsEnvelope } from "./contract-envelope";
import {
  buildRecipeLinePatch,
  recipeLinePatchFields,
} from "./recipe-line-patch";

/** `{items}` over `cookbook.list`'s own output — see `mcpItemsEnvelope`. */
const cookbookSummariesMcpOut = mcpItemsEnvelope(
  fromContract(cookbookContract.ops.list),
);

/** `{items}` over `recipe.getAllTags`'s own output — see `mcpItemsEnvelope`. */
const recipeTagsListOut = mcpItemsEnvelope(
  fromContract(recipeContract.ops.getAllTags),
);

const recipeNutritionInput = z.object({
  recipeId: idParam("recipe"),
  servings: z.number().positive(),
});
const recipeNutritionOut = z.object({
  recipe: z.object({ id: idParam("recipe"), name: z.string() }),
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

type RecipeServingBasis = {
  servings?: number | null;
  yield?: { value: number; unit: string } | null;
};

export const effectiveRecipeServings = (recipe: RecipeServingBasis) =>
  recipe.servings ??
  (recipe.yield?.unit === "servings" ? recipe.yield.value : null);

export const buildRecipeNutrition = (input: {
  recipe: { id: string; name: string };
  recipeServings: number;
  requestedServings: number;
  explain: RecipeCostingExplain;
}) => {
  const scaled = scaleTotals(
    input.explain.computed.totals,
    input.requestedServings / input.recipeServings,
  );
  const unmappedLines = input.explain.computed.diagnostics.flatMap((line) => {
    const reasons = [
      ...(line.missing.weight ? (["weight"] as const) : []),
      ...(line.missing.nutrients ? (["nutrients"] as const) : []),
    ];
    return reasons.length > 0
      ? [{ id: line.id, name: line.name, reasons }]
      : [];
  });
  return recipeNutritionOut.parse({
    recipe: input.recipe,
    recipeServings: input.recipeServings,
    requestedServings: input.requestedServings,
    nutrition: scaled.nutrition,
    coverage: {
      totalLines: input.explain.computed.diagnostics.length,
      mappedLines:
        input.explain.computed.diagnostics.length - unmappedLines.length,
      unmappedLines,
    },
  });
};

const recipeLinePatchInput = z.object({
  recipeId: idParam("recipe"),
  // Declared exception: a recipe line has no shortcode; this is the row id
  // `find_recipes_using_ingredient` (usages[].lineId) and
  // `explain_recipe_costing` (per-line diagnostics id) return.
  lineId: z.uuid(),
  patch: recipeLinePatchFields,
});

const recipeLinePatchOut = z.object({
  recipeId: idParam("recipe"),
  line: z.object({
    type: z.enum(["ingredient", "recipe"]),
    ingredientId: idParam("ingredient").nullable(),
    subRecipeId: idParam("recipe").nullable(),
    amounts: z.array(z.object({ value: z.number(), unit: z.string() })),
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
  }),
});

/** `detail: "lines"` drops both totals blocks and the drift record. */
export function costingExplanation(
  explain: RecipeCostingExplain,
  detail: z.output<typeof recipeCostingExplainDetail>,
) {
  if (detail === "full") return explain;
  const { totals: _persistedTotals, ...persisted } = explain.persisted;
  const { totals: computedTotals, ...computed } = explain.computed;
  return {
    detail: "lines" as const,
    persisted,
    computed,
    coverage: {
      cost: computedTotals.cost,
      kcal: computedTotals.nutrition.kcal,
    },
  };
}

export function registerRecipeTools(server: McpServer) {
  registerMcpTool(server, {
    name: "patch_recipe_line",
    description:
      "Change one recipe ingredient line — its amounts, the ingredient or sub-recipe it points at, or its source text/modifier — without resending the recipe's sections. The line keeps its position and every other line and instruction is left as-is. Get `lineId` from explain_recipe_costing's per-line diagnostics or find_recipes_using_ingredient's usages.",
    inputSchema: recipeLinePatchInput,
    outputSchema: recipeLinePatchOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const context = getEntityKernelContext(extra);
      const detail = await executeEntity(context, {
        action: "get",
        entity: "recipe",
        id: params.recipeId,
        missing: "error",
      });
      if (detail.action !== "get" || detail.entity !== "recipe" || !detail.item)
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      const { sections, line } = buildRecipeLinePatch(
        detail.item,
        params.lineId,
        params.patch,
      );
      await executeEntity(context, {
        action: "update",
        entity: "recipe",
        id: params.recipeId,
        data: { sections },
      });
      return {
        recipeId: params.recipeId,
        line: {
          type: line.type,
          ingredientId: line.ingredientId,
          subRecipeId: line.recipeId,
          amounts: line.amounts,
          rawLine: line.rawLine,
          modifier: line.modifier,
        },
      };
    },
  });

  registerMcpTool(server, {
    name: "get_recipe_nutrition",
    description:
      "Return recipe nutrient totals scaled to a requested serving count, plus mapped-line coverage and compact reasons for unmapped lines. Refuses recipes with no effective serving basis instead of guessing.",
    inputSchema: recipeNutritionInput,
    outputSchema: recipeNutritionOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const context = getEntityKernelContext(extra);
      const detail = await executeEntity(context, {
        action: "get",
        entity: "recipe",
        id: params.recipeId,
        missing: "error",
      });
      if (detail.action !== "get" || !detail.item) {
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      }
      const recipe = z
        .object({
          id: z.string(),
          name: z.string(),
          servings: z.number().nullable().optional(),
          yield: z
            .object({ value: z.number(), unit: z.string() })
            .nullable()
            .optional(),
        })
        .parse(detail.item);
      const recipeServings = effectiveRecipeServings(recipe);
      if (!recipeServings || recipeServings <= 0) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Recipe ${params.recipeId} has no effective serving basis`,
        );
      }
      const resolved = await resolveLiveShortcodes(
        context.db,
        [params.recipeId],
        "recipe",
      );
      const recipeId = resolved.get(params.recipeId);
      if (!recipeId) {
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      }
      const explain =
        await context.services.recipeCosting.explainRecipe(recipeId);
      return buildRecipeNutrition({
        recipe: { id: params.recipeId, name: recipe.name },
        recipeServings,
        requestedServings: params.servings,
        explain,
      });
    },
  });

  registerRouterTool(server, {
    name: "find_cookable_recipes",
    description:
      "Rank recipes by planning coverage. Coverage distinguishes recorded inventory from ingredients marked usually on hand; quantity and blocked-sub-recipe warnings remain visible.",
    inputSchema: z.object({
      minCoverage: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Only return recipes with at least this coverage (0..1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max recipes to return (default 24, max 100)"),
    }),
    outputSchema: recipeAvailabilityMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) => {
      const { recipes } = await getMakeableWorkflow(
        context.readDb,
        { minCoverage: params.minCoverage, limit: params.limit },
        context.services.availability,
      );
      return { recipes };
    },
  });

  registerRouterTool(server, {
    name: "find_recipes_using_ingredient",
    description:
      "Reverse lookup: given an ingredient ID, return every recipe that uses it.",
    inputSchema: z.object({ id: idParam("ingredient") }),
    // `recipesUsingIngredientOut`'s `ingredientId`/`recipes[].id` are already
    // shortcode-typed at the schema level (packages/schemas/recipe.ts), and
    // `slimRecipe` already returns `id: shortcode` — nothing to swap here.
    outputSchema: recipesUsingIngredientOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) => {
      const usages = await recipeUsagesWorkflow(context.readDb, {
        id: params.id,
      });
      const recipes = Object.values(groupBy(usages, (u) => u.recipe.id)).map(
        (rows) => ({
          ...slimRecipe(rows[0]!.recipe),
          usages: rows.map((u) => ({
            lineId: u.id,
            sectionName: u.sectionName ?? null,
            amounts: u.amounts,
            rawLine: u.rawLine ?? null,
            modifier: u.modifier ?? null,
          })),
        }),
      );
      // `params.id` is the shortcode the tool was called with — the seed's
      // own uuid never enters this handler, so no reverse lookup is needed.
      return { ingredientId: params.id, count: recipes.length, recipes };
    },
  });

  registerRouterTool(server, {
    name: "scrape_recipe",
    description:
      "Parse a recipe from a URL into structured form WITHOUT saving it.",
    inputSchema: z.object({ url: scrapeRecipeInput }),
    outputSchema: scrapeRecipeMcpOut,
    annotations: READ_ONLY_OPEN,
    call: (_context, params) => scrapeWorkflow(params.url),
  });

  registerRouterTool(server, {
    name: "import_recipe",
    description:
      "Scrape a recipe from a URL and save it in one step. Returns the new recipe's shortcode.",
    inputSchema: z.object({ url: scrapeRecipeInput }),
    outputSchema: recipeImportIdOut,
    annotations: WRITE_CLOSED,
    call: async (context, params) =>
      await insertImportWorkflow(context, await scrapeWorkflow(params.url)),
  });

  registerRouterTool(server, {
    name: "create_recipe_from_text",
    description:
      "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs.",
    inputSchema: mcpRecipeCreateFromTextInput,
    outputSchema: recipeImportIdOut,
    annotations: WRITE_CLOSED,
    call: async (context, params) => {
      const importRecipe = {
        meta: {
          title: params.name,
          description: params.notes || undefined,
          recipe_yield: params.yield || undefined,
        },
        sections: params.sections.map((s) => ({
          name: s.name || undefined,
          ingredients: s.ingredients,
          instructions: s.instructions,
        })),
        references: [],
        servings: params.servings ?? undefined,
      };
      return await insertImportWorkflow(context, importRecipe);
    },
  });

  registerMcpTool(server, {
    name: "list_cookbooks",
    description:
      "List cookbooks (recipe sources) with the number of recipes from each.",
    inputSchema: z.object({}),
    outputSchema: cookbookSummariesMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (_params, extra) => {
      const context = getEntityKernelContext(extra);
      const result = await listCookbooks(context.readDb);
      return { items: result };
    },
  });

  registerRouterTool(server, {
    name: "get_recipe_tags",
    description: "List all distinct recipe tags in use.",
    inputSchema: z.object({}),
    outputSchema: recipeTagsListOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context) => ({
      items: await getAllTagsWorkflow(context.readDb),
    }),
  });

  registerRouterTool(server, {
    name: "explain_recipe_costing",
    description:
      'Explain a recipe\'s cost/calorie totals with per-ingredient diagnostics. `detail: "lines"` drops the two full nutrient-totals blocks and the drift record and returns only the per-line diagnostics plus a cost/kcal coverage headline — use it when hunting the uncovered line, not the number.',
    inputSchema: z.object({
      id: idParam("recipe"),
      detail: recipeCostingExplainDetail.default("lines"),
    }),
    outputSchema: recipeCostingExplainMcpOut,
    annotations: READ_ONLY_CLOSED,
    readPolicy: () => "strong",
    call: async (context, params) => {
      const explain = await explainCostingWorkflow(
        context.readDb,
        { id: params.id },
        context.services.recipeCosting,
      );
      return costingExplanation(explain, params.detail);
    },
  });
}
