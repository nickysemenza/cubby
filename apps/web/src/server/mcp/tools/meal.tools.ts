import {
  mcpMealAddRecipeInput,
  mcpMealCreateInput,
  mcpMealUpdateInput,
  mealDate,
  mealFilterFields,
  mealMcpItemsOut,
  mealMcpListOut,
  mealMcpOut,
  mealScale,
  shoppingListOut,
} from "@cubby/schemas/meal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  READ_ONLY_CLOSED,
  registerEntityCreateTool,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerEntityUpdateTool,
  registerMcpTool,
  registerRouterTool,
  respond,
  respondList,
  slimMeal,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
  withIdInput,
} from "./_shared";

export function registerMealTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "list_meals",
    description:
      "List meals (planned eating occasions), most recent first, optionally bounded by a date range.",
    router: "meal",
    filterFields: mealFilterFields,
    outputSchema: mealMcpListOut,
    slim: slimMeal,
    sort: { orderBy: "date", direction: "desc" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_meal",
    description:
      "Get a single meal by ID, including its planned recipes and cost/calorie totals.",
    router: "meal",
    idLabel: "Meal",
    outputSchema: mealMcpOut,
    slim: slimMeal,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityCreateTool(server, {
    name: "create_meal",
    description:
      "Create a meal on a calendar day. Optionally include recipes (by recipe ID) to plan in one call; use list_recipes/get_recipe to resolve IDs.",
    inputSchema: mcpMealCreateInput.shape,
    outputSchema: mealMcpOut,
    slim: slimMeal,
    annotations: WRITE_CLOSED,
    create: (caller, params) => caller.meal.create(params),
  });

  registerEntityUpdateTool(server, {
    name: "update_meal",
    description:
      "Update a meal's date, name, or sort order. Recipes are managed via add/update/remove_meal_recipe.",
    inputSchema: withIdInput("Meal", mcpMealUpdateInput.shape),
    outputSchema: mealMcpOut,
    slim: slimMeal,
    router: "meal",
    annotations: WRITE_CLOSED,
  });

  registerEntityDeleteTool(server, {
    name: "delete_meals",
    description:
      "Soft-delete meals by IDs. Cascades to the meal's planned recipes.",
    router: "meal",
    entityLabel: "meal",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });

  registerRouterTool(server, {
    name: "get_meals_by_date_range",
    description:
      "Get all meals between two days (inclusive) — the calendar view for a week/range.",
    inputSchema: {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    outputSchema: mealMcpItemsOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => {
      const result = await caller.meal.getByDateRange({
        from: params.from,
        to: params.to,
      });
      return respondList(result, slimMeal);
    },
  });

  registerRouterTool(server, {
    name: "get_shopping_list",
    description:
      "Build a shopping list across all meals in a date range: aggregated need vs. on-hand inventory.",
    inputSchema: {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    outputSchema: shoppingListOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) =>
      caller.meal.getShoppingList({ from: params.from, to: params.to }),
  });

  registerRouterTool(server, {
    name: "add_recipe_to_meal",
    description:
      "Plan a recipe into a meal at a given scale multiplier (1 = as-written).",
    inputSchema: mcpMealAddRecipeInput.shape,
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
