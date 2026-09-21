import { plainDate } from "@cubby/schemas/base-entity";
import {
  ledgerPartyShortcode,
  mealShortcode,
} from "@cubby/schemas/identifiers";
import {
  mealAddRecipeInput,
  mealFoodAmount,
  getMealPreparationsMcpInput,
  getMealPreparationsMcpOut,
  type MealPreparationNutritionDetail,
  mealMcpOut,
  mealRecipeIdInput,
  mealScale,
  mealUpdateRecipeInput,
  shoppingListOut,
  shoppingListInput,
  saveMealRecipePreparationInput,
  saveMealRecipePreparationOut,
} from "@cubby/schemas/meal";
import { nutrientKey } from "@cubby/schemas/nutrition";
import type {
  MeasureEstimate,
  NutritionTotals,
  NutritionTotalsPartial,
} from "@cubby/schemas/nutrition";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";

import {
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  registerRouterTool,
  respond,
  slimMeal,
  WRITE_CLOSED,
} from "./_shared";

const macroKeys = ["kcal", "protein", "carbs", "fat", "fiber"] as const;
const compactEstimate = z.union([
  z.number(),
  z.null(),
  z.literal("pending"),
  z.object({
    lower: z.number(),
    upper: z.number().nullable(),
    partial: z.boolean(),
  }),
]);
const compactNutrition = z.partialRecord(nutrientKey, compactEstimate);
const addRecipeNutritionDetail = z
  .enum(["none", "kcal", "macros", "full"])
  .default("none");
const addRecipeToMealInput = mealAddRecipeInput.extend({
  nutrition: addRecipeNutritionDetail,
});
const addRecipeToMealOut = z.object({
  id: mealShortcode,
  mealRecipeId: mealRecipeIdInput.shape.id.describe(
    "New meal-recipe occurrence ID; use it for update_meal_recipe or remove_meal_recipe.",
  ),
  name: z.string(),
  coverage: z.object({
    cost: compactEstimate,
    kcal: compactEstimate,
  }),
  nutrition: compactNutrition.optional(),
});

export const MEAL_RECIPE_TOOL_NAMES = {
  add: "add_recipe_to_meal",
  update: "update_meal_recipe",
  remove: "remove_meal_recipe",
} as const;
const dailyIntakeInput = z.object({
  date: plainDate,
  partyId: ledgerPartyShortcode,
  nutrition: z.enum(["macros", "full"]).default("macros"),
  includeFoods: z.boolean().default(false),
});
const dailyIntakeOut = z.object({
  date: plainDate,
  partyId: ledgerPartyShortcode,
  status: z.enum(["planned", "logged"]),
  nutrition: compactNutrition.nullable(),
  meals: z.array(
    z.object({
      mealId: mealShortcode,
      name: z.string().nullable(),
      nutrition: compactNutrition,
      foods: z
        .array(
          z.object({
            name: z.string(),
            grams: z.number().nullable(),
            amount: mealFoodAmount.nullable(),
            sourceKind: z.enum(["recipe", "product", "ingredient", "manual"]),
            nutrition: compactNutrition,
          }),
        )
        .optional(),
    }),
  ),
});

function compactValue(value: MeasureEstimate): z.infer<typeof compactEstimate> {
  if (value.status === "unavailable") return null;
  if (value.status === "pending") return "pending";
  if (
    value.status === "complete" &&
    (value.upper === null || value.upper === value.lower)
  )
    return value.lower;
  return {
    lower: value.lower,
    upper: value.upper,
    partial: value.status === "partial",
  };
}

function compactTotals(totals: NutritionTotals, detail: "macros" | "full") {
  const keys = detail === "macros" ? macroKeys : nutrientKey.options;
  return Object.fromEntries(
    keys.map((key) => [key, compactValue(totals.nutrition[key])]),
  );
}

/** Keep cost and the requested nutrient estimates for the legacy preparation read. */
const trimNutrition =
  (detail: MealPreparationNutritionDetail) =>
  (totals: NutritionTotals): NutritionTotalsPartial => {
    if (detail === "full") return totals;
    if (detail === "macros")
      return {
        cost: totals.cost,
        nutrition: Object.fromEntries(
          macroKeys.map((key) => [key, totals.nutrition[key]]),
        ),
      };
    if (detail === "kcal")
      return { cost: totals.cost, nutrition: { kcal: totals.nutrition.kcal } };
    return { cost: totals.cost, nutrition: {} };
  };

export function registerMealTools(server: McpServer) {
  registerMcpTool(server, {
    name: "get_daily_intake",
    description:
      "Read one person's daily nutrition with one line per meal and a daily total. Defaults to macros: kcal plus protein/carbs/fat/fiber in grams. Set includeFoods for food breakdowns, or nutrition=full for all nutrients. Uses the target meal's household date, including leftovers and unconfirmed entered portions. Future dates are planned; today/past are logged. No assigned intake returns nutrition=null and meals=[]. Nutrient null means unavailable, pending means not calculated, and partial bounds describe only known contributions (not bounds on missing food). Exact values are numbers; ranges retain lower/upper. No cost or preparation detail is included.",
    inputSchema: dailyIntakeInput,
    outputSchema: dailyIntakeOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra): Promise<z.infer<typeof dailyIntakeOut>> => {
      const summary = await getCaller(extra).meal.getNutrition({
        date: params.date,
      });
      const person = summary.people.find(
        (person) => person.eater.id === params.partyId,
      );
      return {
        date: params.date,
        partyId: params.partyId,
        status: params.date > householdLocalDate() ? "planned" : "logged",
        nutrition: person
          ? compactTotals(person.totals, params.nutrition)
          : null,
        meals:
          person?.meals.map(({ meal, totals }) => ({
            mealId: meal.id,
            name: meal.name,
            nutrition: compactTotals(totals, params.nutrition),
            foods: params.includeFoods
              ? person.foods
                  .filter((food) => food.meal.id === meal.id)
                  .map((food) => ({
                    name: food.name,
                    grams: food.grams,
                    amount: food.amount,
                    sourceKind: food.sourceKind,
                    nutrition: compactTotals(food.totals, params.nutrition),
                  }))
              : undefined,
          })) ?? [],
      };
    },
  });
  registerMcpTool(server, {
    name: "get_meal_preparations",
    description:
      "Read recipe preparations made by or served at a meal, including projected and confirmed nutrition. `nutrition` trims every totals block: `full` (default) carries all 22 nutrients, `macros` keeps kcal/protein/carbs/fat/fiber, `kcal` keeps only calories for compatibility, and `none` keeps cost alone. For per-person daily intake use get_daily_intake.",
    inputSchema: getMealPreparationsMcpInput,
    outputSchema: getMealPreparationsMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const view = await getCaller(extra).meal.getPreparations({
        mealId: params.mealId,
      });
      const project = trimNutrition(params.nutrition);
      return {
        mealId: view.mealId,
        preparations: view.preparations.map((preparation) => ({
          ...preparation,
          totals: project(preparation.totals),
          portions: preparation.portions.map((portion) => ({
            ...portion,
            totals: project(portion.totals),
          })),
        })),
        totals: {
          confirmed: {
            ...view.totals.confirmed,
            totals: project(view.totals.confirmed.totals),
          },
          projected: {
            ...view.totals.projected,
            totals: project(view.totals.projected.totals),
          },
        },
      };
    },
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
    name: MEAL_RECIPE_TOOL_NAMES.add,
    description:
      "Plan a recipe into a meal at a given scale multiplier (1 = as-written). Returns compact meal identity plus cost/kcal coverage. Nutrition defaults to none; request kcal, macros, or full when needed.",
    inputSchema: addRecipeToMealInput,
    outputSchema: addRecipeToMealOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const result = await caller.meal.addRecipe({
        mealId: params.mealId,
        recipeId: params.recipeId,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      const meal = respond(result.meal, slimMeal);
      const keys =
        params.nutrition === "full"
          ? nutrientKey.options
          : params.nutrition === "macros"
            ? macroKeys
            : params.nutrition === "kcal"
              ? (["kcal"] as const)
              : [];
      return {
        id: meal.id,
        mealRecipeId: result.mealRecipeId,
        name: meal.name ?? meal.mealType ?? meal.date,
        coverage: {
          cost: compactValue(meal.totals.cost),
          kcal: compactValue(meal.totals.nutrition.kcal),
        },
        nutrition:
          keys.length > 0
            ? Object.fromEntries(
                keys.map((key) => [
                  key,
                  compactValue(meal.totals.nutrition[key]),
                ]),
              )
            : undefined,
      };
    },
  });

  registerMcpTool(server, {
    name: "save_meal_recipe_preparation",
    description:
      "Record measured yield and portions served from one planned recipe occurrence. Assigned portions count in daily intake by the target meal date: future is planned, today/past is logged. Confirmation fields remain for legacy compatibility and do not gate daily intake.",
    inputSchema: saveMealRecipePreparationInput,
    outputSchema: saveMealRecipePreparationOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      getCaller(extra).meal.savePreparation(params),
  });

  registerMcpTool(server, {
    name: MEAL_RECIPE_TOOL_NAMES.update,
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
    name: MEAL_RECIPE_TOOL_NAMES.remove,
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
