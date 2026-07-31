import {
  mealAddRecipeInput,
  mealCreateInput,
  mealDate,
  mealFilterFields,
  mealMcpItemsOut,
  mealMcpListOut,
  mealMcpOut,
  mealRecipeInput,
  mealScale,
  mealUpdateData,
  shoppingListOut,
} from "@cubby/schemas/meal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SHOPPING_LIST_UI } from "../apps";
import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  resolvePublicId,
  resolvePublicIdMap,
  respond,
  respondList,
  slimMeal,
  WRITE_CLOSED,
} from "./_shared";

/**
 * `shoppingListOut.meals[]` is `{id, name, date}` — a summary list distinct
 * from `items[].perMeal[]`'s `shoppingListContribution` rows, which already
 * carry `mealShortcode`/`recipeShortcode`/`ingredientShortcode` siblings from
 * the previous cutover pass. This inline summary shape never got one, so
 * `get_shopping_list`'s handler resolves it via `shortcode.lookupMany` below
 * rather than editing packages/schemas.
 */
const shoppingListMealMcpOut = shoppingListOut.shape.meals.element
  .omit({ id: true })
  .extend({ mealShortcode: z.string().nullable() });

const shoppingListContributionMcpOut =
  shoppingListOut.shape.items.element.shape.perMeal.element.omit({
    mealId: true,
    recipeId: true,
  });

const shoppingListItemMcpOut = shoppingListOut.shape.items.element
  .omit({ ingredientId: true, perMeal: true })
  .extend({ perMeal: z.array(shoppingListContributionMcpOut) });

const shoppingListMcpOut = shoppingListOut
  .omit({ meals: true, items: true })
  .extend({
    meals: z.array(shoppingListMealMcpOut),
    items: z.array(shoppingListItemMcpOut),
  });

/**
 * `mealCreateInput`/`mealAddRecipeInput` are shared with the tRPC router (and
 * meal-table.tsx), so the branded-uuid `recipeId`/`mealId` fields stay as-is
 * there — these MCP-only overrides carry the shortcode swap instead.
 */
const mealRecipeMcpInput = mealRecipeInput.extend({
  recipeId: idParam("recipe").describe(
    "Recipe shortcode to plan into the meal",
  ),
});

const mealCreateMcpInput = mealCreateInput.extend({
  recipes: z.array(mealRecipeMcpInput).optional(),
});

const mealAddRecipeMcpInput = mealAddRecipeInput.extend({
  mealId: idParam("meal"),
  recipeId: idParam("recipe").describe(
    "Recipe shortcode to plan into the meal",
  ),
});

export function registerMealTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "meal",
    createInput: mealCreateMcpInput.shape,
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
    create: async (caller, params) => {
      const recipes = params.recipes as
        | Array<{ recipeId: string; scale: number; sortOrder?: number | null }>
        | undefined;
      if (!recipes?.length) return caller.meal.create(params);
      const idByCode = await resolvePublicIdMap(
        caller,
        "recipe",
        recipes.map((r) => r.recipeId),
      );
      return caller.meal.create({
        ...params,
        recipes: recipes.map((r) => ({
          ...r,
          recipeId: idByCode.get(r.recipeId)!,
        })),
      });
    },
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

  registerMcpTool(server, {
    name: "get_shopping_list",
    description:
      "Build a shopping list across all meals in a date range: aggregated need vs. on-hand inventory.",
    inputSchema: {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    outputSchema: shoppingListMcpOut,
    annotations: READ_ONLY_CLOSED,
    uiResourceUri: SHOPPING_LIST_UI,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.getShoppingList({
        from: params.from,
        to: params.to,
      });
      const mealIds = result.meals.map((m) => m.id);
      const resolved = mealIds.length
        ? await caller.shortcode.lookupMany({
            refs: mealIds.map((id) => ({ entity: "meal" as const, id })),
          })
        : [];
      const codeByMealId = new Map(resolved.map((r) => [r.id, r.shortcode]));
      return {
        ...result,
        meals: result.meals.map(({ id, ...m }) => ({
          ...m,
          mealShortcode: codeByMealId.get(id) ?? null,
        })),
        items: result.items.map(({ ingredientId: _ingredientId, ...item }) => ({
          ...item,
          perMeal: item.perMeal.map(
            ({ mealId: _mealId, recipeId: _recipeId, ...contribution }) =>
              contribution,
          ),
        })),
      };
    },
  });

  registerRouterTool(server, {
    name: "add_recipe_to_meal",
    description:
      "Plan a recipe into a meal at a given scale multiplier (1 = as-written).",
    inputSchema: mealAddRecipeMcpInput.shape,
    outputSchema: mealMcpOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const [mealId, recipeId] = await Promise.all([
        resolvePublicId(caller, "meal", params.mealId),
        resolvePublicId(caller, "recipe", params.recipeId),
      ]);
      const result = await caller.meal.addRecipe({
        mealId,
        recipeId,
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
