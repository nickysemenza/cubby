import {
  mealAddRecipeInput,
  mealDate,
  mealMcpOut,
  mealScale,
  shoppingListOut,
} from "@cubby/schemas/meal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  registerRouterTool,
  respond,
  slimMeal,
  WRITE_CLOSED,
} from "./_shared";

export function registerMealTools(server: McpServer) {
  registerMcpTool(server, {
    name: "get_shopping_list",
    description:
      "Use this when the user asks what to buy or what they are short on for planned meals in a date range. It compares aggregate recipe needs with on-hand inventory and returns the result as structured data and readable text. Do not invoke it to add arbitrary manual household shopping items.",
    inputSchema: z.object({
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    }),
    outputSchema: shoppingListOut,
    annotations: READ_ONLY_CLOSED,
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
    inputSchema: mealAddRecipeInput,
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
    inputSchema: z.object({
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
    }),
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
    inputSchema: z.object({
      // mealRecipe.id is a declared exception — see update_meal_recipe above.
      id: z
        .string()
        .describe(
          "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
        ),
    }),
    outputSchema: mealMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.removeRecipe({ id: params.id });
      return respond(result, slimMeal);
    },
  });
}
