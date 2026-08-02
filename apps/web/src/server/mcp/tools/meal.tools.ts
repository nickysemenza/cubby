import {
  mealAddRecipeInput,
  mealCreateInput,
  mealDate,
  mealFilterFields,
  mealMcpListOut,
  mealMcpOut,
  mealScale,
  mealUpdateData,
  shoppingListOut,
} from "@cubby/schemas/meal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SHOPPING_LIST_UI } from "../apps";
import {
  getCaller,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  respond,
  slimMeal,
  WRITE_CLOSED,
} from "./_shared";

export function registerMealTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "meal",
    createInput: mealCreateInput.shape,
    updateShape: mealUpdateData.shape,
    filterFields: mealFilterFields,
    mcpListOut: mealMcpListOut,
    out: mealMcpOut,
    slim: slimMeal,
    sort: { orderBy: "date", direction: "desc" },
    descriptions: {
      list: "List meals (planned eating occasions), most recent first, optionally bounded by a date range.",
      get: "Get a single meal by ID, including its planned recipes and cost/calorie totals.",
      create:
        "Create a meal on a calendar day. Optionally include recipes (by recipe shortcode) to plan in one call; use list_recipes/get_recipe to resolve shortcodes.",
      update:
        "Update a meal's date, name, or sort order. Recipes are managed via add/update/remove_meal_recipe.",
      delete:
        "Soft-delete meals by IDs. Cascades to the meal's planned recipes.",
    },
    create: (caller, params) => caller.meal.create(params),
  });

  registerMcpTool(server, {
    name: "get_shopping_list",
    description:
      "Build a shopping list across all meals in a date range: aggregated need vs. on-hand inventory.",
    inputSchema: {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    outputSchema: shoppingListOut,
    annotations: READ_ONLY_CLOSED,
    uiResourceUri: SHOPPING_LIST_UI,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      return await caller.meal.getShoppingList({
        from: params.from,
        to: params.to,
      });
    },
  });

  registerRouterTool(server, {
    name: "add_recipe_to_meal",
    description:
      "Plan a recipe into a meal at a given scale multiplier (1 = as-written).",
    inputSchema: mealAddRecipeInput.shape,
    outputSchema: mealMcpOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const result = await caller.meal.addRecipe({
        mealId: params.mealId,
        recipeId: params.recipeId,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      return respond(result, slimMeal);
    },
  });

  registerMcpTool(server, {
    name: "update_meal_recipe",
    description:
      "Adjust a planned recipe's scale or sort order within its meal.",
    inputSchema: {
      // mealRecipe.id is a declared exception — no shortcode exists for the
      // meal-recipe join row, so this stays the raw uuid.
      id: z
        .string()
        .describe(
          "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
        ),
      scale: mealScale.optional().describe("New scale multiplier (e.g. 1.5)"),
      sortOrder: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("New sort order"),
    },
    outputSchema: mealMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.updateRecipe({
        id: params.id,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      return respond(result, slimMeal);
    },
  });

  registerMcpTool(server, {
    name: "remove_meal_recipe",
    description: "Remove a planned recipe from its meal.",
    inputSchema: {
      // mealRecipe.id is a declared exception — see update_meal_recipe above.
      id: z
        .string()
        .describe(
          "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
        ),
    },
    outputSchema: mealMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.removeRecipe({ id: params.id });
      return respond(result, slimMeal);
    },
  });
}
