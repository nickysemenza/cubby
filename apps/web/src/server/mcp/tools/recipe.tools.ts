import {
  mcpRecipeCreateFromTextInput,
  scrapeRecipeInput,
} from "@cubby/schemas/import-recipe";
import {
  cookbookSummariesMcpOut,
  mcpRecipeCreateInput,
  mcpRecipeUpdateInput,
  recipeAvailabilityMcpOut,
  recipeCostingExplainMcpOut,
  recipeDetailMcpOut,
  recipeIdOut,
  recipeMcpListOut,
  recipeRecomputeMcpOut,
  recipesUsingIngredientOut,
  recipeTagsListOut,
  scrapeRecipeMcpOut,
} from "@cubby/schemas/mcp";
import type { RecipeUsage } from "@cubby/schemas/recipe";
import { recipeListFilterFields, recipeMcpOut } from "@cubby/schemas/recipe";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { groupBy } from "es-toolkit";
import { z } from "zod";
import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerEntityCreateTool,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerEntityUpdateTool,
  registerMcpTool,
  registerRouterTool,
  slimRecipe,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

export function registerRecipeTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "list_recipes",
    description:
      "List recipes by name. Returns id, name, shortcode, yield, servings, tags.",
    router: "recipe",
    filterFields: recipeListFilterFields,
    outputSchema: recipeMcpListOut,
    slim: slimRecipe,
    sort: { orderBy: "name" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_recipe",
    description:
      "Get a recipe by ID, including sections, ingredients, and instructions.",
    router: "recipe",
    idLabel: "Recipe",
    outputSchema: recipeDetailMcpOut,
    annotations: READ_ONLY_CLOSED,
  });

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
      const recipes = await caller.suggestions.getMakeable({
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
    inputSchema: { id: idParam("Ingredient") },
    outputSchema: recipesUsingIngredientOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const usages = (await caller.ingredient.recipeUsages({
        id: params.id,
      })) as RecipeUsage[];
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
      "Scrape a recipe from a URL and save it in one step. Returns the new recipe's id.",
    inputSchema: { url: scrapeRecipeInput },
    outputSchema: recipeIdOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const imported = await caller.recipe.scrape(params.url);
      const result = await caller.recipe.insertImport(imported);
      return { id: result.id };
    },
  });

  registerMcpTool(server, {
    name: "create_recipe_from_text",
    description:
      "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs.",
    inputSchema: mcpRecipeCreateFromTextInput.shape,
    outputSchema: recipeIdOut,
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
      const result = await caller.recipe.insertImport(importRecipe);
      return { id: result.id };
    },
  });

  registerEntityCreateTool(server, {
    name: "create_recipe",
    description:
      "Create a recipe from structured input (sections with ingredient IDs and instructions).",
    inputSchema: mcpRecipeCreateInput,
    outputSchema: recipeMcpOut,
    slim: slimRecipe,
    annotations: WRITE_CLOSED,
    create: (caller, params) => caller.recipe.create(params),
  });

  registerEntityUpdateTool(server, {
    name: "update_recipe",
    description: "Update a recipe's fields. Only provided fields are changed.",
    inputSchema: mcpRecipeUpdateInput,
    outputSchema: recipeMcpOut,
    slim: slimRecipe,
    router: "recipe",
    annotations: WRITE_CLOSED,
  });

  registerEntityDeleteTool(server, {
    name: "delete_recipe",
    description: "Soft-delete recipes by IDs.",
    router: "recipe",
    entityLabel: "recipe",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });

  registerRouterTool(server, {
    name: "list_cookbooks",
    description:
      "List cookbooks (recipe sources) with the number of recipes from each.",
    outputSchema: cookbookSummariesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller) => {
      const result = await caller.recipe.listCookbooks();
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
    name: "recompute_recipe_totals",
    description:
      "Recompute every recipe's persisted cost/calorie totals (one-shot backfill / recovery).",
    outputSchema: recipeRecomputeMcpOut,
    annotations: WRITE_CLOSED,
    call: (caller) => caller.recipe.recomputeAll(),
  });

  registerRouterTool(server, {
    name: "explain_recipe_costing",
    description:
      "Explain a recipe's cost/calorie totals with per-ingredient diagnostics.",
    inputSchema: { id: z.string().describe("Recipe ID") },
    outputSchema: recipeCostingExplainMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.recipe.explainCosting({ id: params.id }),
  });
}
