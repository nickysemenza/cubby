import {
  mealAddRecipeInput,
  getMealPreparationsInput,
  getMealPreparationsOut,
  mealMcpOut,
  mealRecipeIdInput,
  mealScale,
  mealUpdateRecipeInput,
  shoppingListOut,
  shoppingListInput,
  saveMealRecipePreparationInput,
  saveMealRecipePreparationOut,
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
    name: "get_meal_preparations",
    description:
      "Read recipe preparations made by or served at a meal, including projected and confirmed nutrition.",
    inputSchema: getMealPreparationsInput,
    outputSchema: getMealPreparationsOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) =>
      getCaller(extra).meal.getPreparations(params),
  });

  registerMcpTool(server, {
    name: "get_shopping_list",
    description:
      "Use this when the user asks what to buy or what they are short on for planned meals in a date range. It compares aggregate recipe needs with recorded inventory. Usually-on-hand ingredients are assumed available, listed separately, and excluded from shopping estimates; assumptions never represent recorded stock. Quantity issues and blocked sub-recipes disclose incomplete information. Do not invoke it to add arbitrary manual household shopping items.",
    inputSchema: shoppingListInput,
    outputSchema: shoppingListOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      return await caller.meal.getShoppingList({
        from: params.from,
        to: params.to,
        excludedMealIds: params.excludedMealIds,
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
    name: "save_meal_recipe_preparation",
    description:
      "Record measured yield and portions served from one planned recipe occurrence. Confirmed portions count as consumed; unconfirmed portions remain projected.",
    inputSchema: saveMealRecipePreparationInput,
    outputSchema: saveMealRecipePreparationOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      getCaller(extra).meal.savePreparation(params),
  });

  registerMcpTool(server, {
    name: "update_meal_recipe",
    description:
      "Adjust a planned recipe's scale or sort order within its meal.",
    inputSchema: z.object({
      // mealRecipe.id is a declared exception — no shortcode exists for the
      // meal-recipe join row, so this stays the raw uuid.
      id: mealUpdateRecipeInput.shape.id.describe(
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
      id: mealRecipeIdInput.shape.id.describe(
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
