import { plainDate } from "@cubby/schemas/base-entity";
import {
  ledgerPartyShortcode,
  mealShortcode,
} from "@cubby/schemas/identifiers";
import * as schemas from "@cubby/schemas/meal";
import { nutrientKey } from "@cubby/schemas/nutrition";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/** An estimate as one number when exact, `pending`, null when unavailable, else bounds. */
export const compactEstimate = z.union([
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

export const addRecipeNutritionDetail = z
  .enum(["none", "kcal", "macros", "full"])
  .default("none");

const planRecipeOut = z.object({
  id: mealShortcode,
  mealRecipeId: schemas.mealRecipeIdInput.shape.id.describe(
    "New meal-recipe occurrence ID; use it for meal_recipe update or remove.",
  ),
  name: z.string(),
  coverage: z.object({
    cost: compactEstimate,
    kcal: compactEstimate,
  }),
  nutrition: compactNutrition.optional(),
});

export const mealDuplicateInput = z.object({
  mealId: mealShortcode,
  date: plainDate
    .optional()
    .describe("Day for the copy; defaults to the source meal's day"),
});

export const mealCopyRangeInput = z.object({
  from: plainDate.describe("First day to copy, inclusive"),
  to: plainDate.describe("Last day to copy, inclusive"),
  targetFrom: plainDate.describe(
    "Day the range's first day lands on; later days keep their offset",
  ),
});
const mealCopyRangeOut = z.object({
  copied: z.number().int().nonnegative(),
  mealIds: z.array(mealShortcode),
  skippedPortions: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Portions not copied because their source or target meal was outside the range",
    ),
});

export const dailyIntakeInput = z.object({
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
            amount: schemas.mealFoodAmount.nullable(),
            sourceKind: z.enum(["recipe", "product", "ingredient", "manual"]),
            nutrition: compactNutrition,
          }),
        )
        .optional(),
    }),
  ),
});

export const mealContract = defineContract("meal", {
  // Bounded Home summary; see expense.monthlySummary.
  getNutrition: query({
    readPolicy: "strong",
    native: "Meal and daily macro summaries",
    input: schemas.mealNutritionInput,
    output: schemas.mealNutritionOut,
    cache: {
      tags: [
        ["meal", "getNutrition"],
        ["product"],
        ["ingredient"],
        ["recipe"],
        ["ledgerParty"],
      ],
    },
  }),
  saveFood: mutation({
    input: schemas.saveMealFoodInput,
    output: schemas.mealFoodMutationOut,
    invalidates: ["meal"],
  }),
  removeFood: mutation({
    input: schemas.removeMealFoodInput,
    output: schemas.mealFoodMutationOut,
    invalidates: ["meal"],
  }),
  getByDateRange: query({
    input: schemas.mealDateRange,
    output: schemas.mealListOut,
  }),
  upcomingSummary: query({
    readPolicy: "strong",
    input: schemas.mealDateRange,
    output: schemas.upcomingMealSummaryOut,
  }),
  getPreparations: query({
    input: schemas.getMealPreparationsInput,
    output: schemas.getMealPreparationsOut,
    cache: { tags: [["meal", "getPreparations"], ["recipe"]] },
  }),
  getShoppingList: query({
    input: schemas.shoppingListInput,
    output: schemas.shoppingListOut,
  }),
  addRecipe: mutation({
    native: "Plan a recipe into a meal from its composition report",
    input: schemas.mealAddRecipeInput,
    output: schemas.mealOut,
    invalidates: ["meal"],
  }),
  updateRecipe: mutation({
    native: "Change a meal recipe's scale from the composition report",
    input: schemas.mealUpdateRecipeInput,
    output: schemas.mealOut,
    invalidates: ["meal"],
  }),
  removeRecipe: mutation({
    native: "Remove a recipe from a meal from the composition report",
    input: schemas.mealRecipeIdInput,
    output: schemas.mealOut,
    invalidates: ["meal"],
  }),
  // Copies are plans: planned portions, no images, appended to the target days.
  duplicate: mutation({
    input: mealDuplicateInput,
    output: schemas.mealOut,
    invalidates: ["meal"],
  }),
  copyRange: mutation({
    input: mealCopyRangeInput,
    output: mealCopyRangeOut,
    invalidates: ["meal"],
  }),
  savePreparation: mutation({
    native: "Set or remove portions and the yield from the composition report",
    input: schemas.saveMealRecipePreparationInput,
    output: schemas.saveMealRecipePreparationOut,
    invalidates: ["meal"],
  }),
  // Agent-facing (MCP `nutrition`, `meal_recipe`): off the HTTP API.
  /** One person's daily nutrition, one line per meal plus a daily total. */
  dailyIntake: query({
    http: false,
    input: dailyIntakeInput,
    output: dailyIntakeOut,
  }),
  /** `getPreparations` with every totals block trimmed to `nutrition`. */
  preparationsDetail: query({
    http: false,
    input: schemas.getMealPreparationsMcpInput,
    output: schemas.getMealPreparationsMcpOut,
  }),
  /** Plan a recipe into a meal; compact identity + coverage, nutrients on request. */
  planRecipe: mutation({
    http: false,
    input: schemas.mealAddRecipeInput.extend({
      nutrition: addRecipeNutritionDetail,
    }),
    output: planRecipeOut,
    invalidates: ["meal"],
  }),
});
