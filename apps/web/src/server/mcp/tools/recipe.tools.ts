import {
  mcpRecipeCreateFromTextInput,
  recipeImportIdOut,
  scrapeRecipeInput,
} from "@cubby/schemas/import-recipe";
import {
  cookbookSummariesMcpOut,
  recipeAvailabilityMcpOut,
  recipeCostingExplainMcpOut,
  recipesUsingIngredientOut,
  recipeTagsListOut,
  scrapeRecipeMcpOut,
} from "@cubby/schemas/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
import { z } from "zod";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { listCookbooks } from "~/server/repo/cookbook";
import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerMcpTool,
  registerRouterTool,
  slimRecipe,
  WRITE_CLOSED,
} from "./_shared";

export function registerRecipeTools(server: McpServer) {
  registerRouterTool(server, {
    name: "find_cookable_recipes",
    description:
      "Rank recipes by how well current inventory covers their ingredients.",
    inputSchema: {
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
    },
    outputSchema: recipeAvailabilityMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => {
      const { recipes } = await caller.suggestions.getMakeable({
        minCoverage: params.minCoverage,
        limit: params.limit,
      });
      return { recipes };
    },
  });

  registerMcpTool(server, {
    name: "find_recipes_using_ingredient",
    description:
      "Reverse lookup: given an ingredient ID, return every recipe that uses it.",
    inputSchema: { id: idParam("ingredient") },
    // `recipesUsingIngredientOut`'s `ingredientId`/`recipes[].id` are already
    // shortcode-typed at the schema level (packages/schemas/recipe.ts), and
    // `slimRecipe` already returns `id: shortcode` — nothing to swap here.
    outputSchema: recipesUsingIngredientOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const usages = await caller.ingredient.recipeUsages({ id: params.id });
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
    inputSchema: { url: scrapeRecipeInput },
    outputSchema: scrapeRecipeMcpOut,
    annotations: READ_ONLY_OPEN,
    call: (caller, params) => caller.recipe.scrape(params.url),
  });

  registerRouterTool(server, {
    name: "import_recipe",
    description:
      "Scrape a recipe from a URL and save it in one step. Returns the new recipe's shortcode.",
    inputSchema: { url: scrapeRecipeInput },
    outputSchema: recipeImportIdOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const imported = await caller.recipe.scrape(params.url);
      return await caller.recipe.insertImport(imported);
    },
  });

  registerMcpTool(server, {
    name: "create_recipe_from_text",
    description:
      "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs.",
    inputSchema: mcpRecipeCreateFromTextInput.shape,
    outputSchema: recipeImportIdOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const input = mcpRecipeCreateFromTextInput.parse(params);
      const importRecipe = {
        meta: {
          title: input.name,
          ...(input.notes ? { description: input.notes } : {}),
          ...(input.yield ? { recipe_yield: input.yield } : {}),
        },
        sections: input.sections.map((s) => ({
          ...(s.name ? { name: s.name } : {}),
          ingredients: s.ingredients,
          instructions: s.instructions,
        })),
        references: [],
        ...(input.servings != null ? { servings: input.servings } : {}),
      };
      return await caller.recipe.insertImport(importRecipe);
    },
  });

  registerMcpTool(server, {
    name: "list_cookbooks",
    description:
      "List cookbooks (recipe sources) with the number of recipes from each.",
    outputSchema: cookbookSummariesMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (_params, extra) => {
      const context = extra.authInfo?.extra?.entityKernel as
        | EntityKernelContext
        | undefined;
      if (!context) throw new Error("MCP entity kernel context is missing");
      const result = await listCookbooks(context.readDb);
      return { items: result };
    },
  });

  registerRouterTool(server, {
    name: "get_recipe_tags",
    description: "List all distinct recipe tags in use.",
    outputSchema: recipeTagsListOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller) => {
      const result = await caller.recipe.getAllTags();
      return { items: result };
    },
  });

  registerRouterTool(server, {
    name: "explain_recipe_costing",
    description:
      "Explain a recipe's cost/calorie totals with per-ingredient diagnostics.",
    inputSchema: { id: idParam("recipe") },
    outputSchema: recipeCostingExplainMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.recipe.explainCosting({ id: params.id }),
  });
}
