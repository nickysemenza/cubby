import {
  mealCreateInput,
  mealDate,
  mealRecipeInput,
  mealScale,
  mealUpdateData,
} from "@cubby/schemas/meal";
import { mcpPaginationParams } from "@cubby/schemas/pagination";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deleteHandler,
  getByIdHandler,
  getCaller,
  idParam,
  idsParam,
  json,
  listHandler,
  respond,
  respondList,
  slimMeal,
  updateHandler,
  withErrorHandling,
} from "./_shared";

// A meal is a planned eating occasion on a calendar day grouping one or more
// recipes (each at a `scale` multiplier). Cost/calorie rollups derive from
// recipe.totals × scale. The per-recipe `id` in a meal's `recipes[]` is the
// mealRecipe id — pass THAT (not the recipe id) to update/remove_meal_recipe.

export function registerMealTools(server: McpServer) {
  server.tool(
    "list_meals",
    "List meals (planned eating occasions), most recent first, optionally bounded by a date range.",
    {
      from: mealDate.optional().describe("Only meals on or after this day"),
      to: mealDate.optional().describe("Only meals on or before this day"),
      ...mcpPaginationParams,
    },
    listHandler("meal", slimMeal, {
      orderBy: "date",
      direction: "desc",
      buildFilters: (p) => ({ from: p.from, to: p.to }),
    }),
  );

  server.tool(
    "get_meal",
    "Get a single meal by ID, including its planned recipes and cost/calorie totals.",
    { id: idParam("Meal") },
    getByIdHandler("meal", slimMeal),
  );

  server.tool(
    "create_meal",
    "Create a meal on a calendar day. Optionally include recipes (by recipe ID) to plan in one call; use list_recipes/get_recipe to resolve IDs.",
    mealCreateInput.shape,
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.create(params);
      return respond(result, slimMeal);
    }),
  );

  server.tool(
    "update_meal",
    "Update a meal's date, name, or sort order. Recipes are managed via add/update/remove_meal_recipe.",
    {
      id: idParam("Meal"),
      ...mealUpdateData.shape,
    },
    updateHandler("meal", slimMeal),
  );

  server.tool(
    "delete_meals",
    "Soft-delete meals by IDs. Cascades to the meal's planned recipes.",
    { ids: idsParam("meal") },
    deleteHandler("meal"),
  );

  server.tool(
    "get_meals_by_date_range",
    "Get all meals between two days (inclusive) — the calendar view for a week/range.",
    {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.getByDateRange({
        from: params.from,
        to: params.to,
      });
      return respondList(result, slimMeal);
    }),
  );

  server.tool(
    "get_shopping_list",
    "Build a shopping list across all meals in a date range: aggregated need vs. on-hand inventory, the shortfall to buy, and a per-meal breakdown of who needs each item. Read-only — never mutates inventory.",
    {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.getShoppingList({
        from: params.from,
        to: params.to,
      });
      return json(result);
    }),
  );

  server.tool(
    "add_recipe_to_meal",
    "Plan a recipe into a meal at a given scale multiplier (1 = as-written).",
    {
      mealId: idParam("Meal"),
      ...mealRecipeInput.shape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.addRecipe({
        mealId: params.mealId,
        recipeId: params.recipeId,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      return respond(result, slimMeal);
    }),
  );

  server.tool(
    "update_meal_recipe",
    "Adjust a planned recipe's scale or sort order within its meal.",
    {
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
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.updateRecipe({
        id: params.id,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      return respond(result, slimMeal);
    }),
  );

  server.tool(
    "remove_meal_recipe",
    "Remove a planned recipe from its meal.",
    {
      id: z
        .string()
        .describe(
          "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.removeRecipe({ id: params.id });
      return respond(result, slimMeal);
    }),
  );
}
