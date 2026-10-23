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

export const mealContract = defineContract(
  "meal",
  {
    // Bounded Home summary; see expense.monthlySummary.
    getNutrition: query({
      exposure: "view",
      note: "Home macro tiles for a meal or a household day; agents read nutrition_read.daily_intake per person and nutrition_read.preparations_detail per meal",
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
      description:
        "Add or update a food entry on a Meal using its declared amount and nutrition fields. Read daily_intake afterward to confirm the saved meal.",
      command: { label: "Save food", confirmation: null },
      input: schemas.saveMealFoodInput,
      output: schemas.mealFoodMutationOut,
      invalidates: ["meal"],
    }),
    removeFood: mutation({
      description:
        "Remove one food entry from a Meal. Read the Meal afterward to confirm the intended entry was removed.",
      command: { label: "Remove food", confirmation: null },
      input: schemas.removeMealFoodInput,
      output: schemas.mealFoodMutationOut,
      invalidates: ["meal"],
    }),
    getByDateRange: query({
      exposure: "view",
      note: "entity_read.list on meals filtered by mealDate",
      input: schemas.mealDateRange,
      output: schemas.mealListOut,
    }),
    upcomingSummary: query({
      exposure: "view",
      readPolicy: "strong",
      input: schemas.mealDateRange,
      output: schemas.upcomingMealSummaryOut,
    }),
    getPreparations: query({
      exposure: "view",
      input: schemas.getMealPreparationsInput,
      output: schemas.getMealPreparationsOut,
      cache: { tags: [["meal", "getPreparations"], ["recipe"]] },
    }),
    getShoppingList: query({
      description:
        "Use this when the user asks what to buy or what they are short on for planned meals in a date range. It compares aggregate recipe needs with recorded inventory. Usually-on-hand ingredients are assumed available, listed separately, and excluded from shopping estimates; assumptions never represent recorded stock. Quantity issues and blocked sub-recipes disclose incomplete information. Do not invoke it to add arbitrary manual household shopping items.",
      input: schemas.shoppingListInput,
      output: schemas.shoppingListOut,
    }),
    addRecipe: mutation({
      exposure: "view",
      command: {
        label: "Add recipe",
        confirmation: null,
        booleanInputs: ["convertToCooked"],
        inputs: [
          {
            kind: "record",
            key: "recipeId",
            label: "Recipe",
            entity: "recipe",
          },
          {
            kind: "number",
            key: "scale",
            label: "Scale",
            initial: 1,
            min: 0.01,
          },
        ],
      },
      native: "Plan a recipe into a meal from its composition report",
      input: schemas.mealAddRecipeInput,
      output: schemas.mealOut,
      invalidates: ["meal"],
    }),
    updateRecipe: mutation({
      description:
        "Adjust a planned recipe's scale or sort order within its meal.",
      command: {
        label: "Change scale",
        confirmation: null,
        inputs: [
          {
            kind: "number",
            key: "scale",
            label: "Scale",
            initial: null,
            min: 0.01,
          },
        ],
      },
      native: "Change a meal recipe's scale from the composition report",
      input: schemas.mealUpdateRecipeInput,
      output: schemas.mealOut,
      invalidates: ["meal"],
    }),
    removeRecipe: mutation({
      description: "Remove a planned recipe from its meal.",
      command: { label: "Remove recipe", confirmation: null },
      native: "Remove a recipe from a meal from the composition report",
      input: schemas.mealRecipeIdInput,
      output: schemas.mealOut,
      invalidates: ["meal"],
    }),
    // Copies are plans: planned portions, no images, appended to the target days.
    duplicate: mutation({
      description:
        "Copy a Meal and its food entries to the requested date. The new Meal is a separate record; inspect it before further edits.",
      command: { label: "Duplicate meal", confirmation: null },
      input: mealDuplicateInput,
      output: schemas.mealOut,
      invalidates: ["meal"],
    }),
    copyRange: mutation({
      description:
        "Copy Meals from the selected date range to the requested destination dates. This creates new Meal records; inspect the returned ids before retrying.",
      command: { label: "Copy meals", confirmation: null },
      input: mealCopyRangeInput,
      output: mealCopyRangeOut,
      invalidates: ["meal"],
    }),
    savePreparation: mutation({
      description:
        "Record measured yield and portions served from one planned recipe occurrence. Assigned portions count in daily intake by the target meal date: future is planned, today/past is logged. Confirmation fields remain for legacy compatibility and do not gate daily intake.",
      command: { label: "Save preparation", confirmation: null },
      native:
        "Set or remove portions and the yield from the composition report",
      input: schemas.saveMealRecipePreparationInput,
      output: schemas.saveMealRecipePreparationOut,
      invalidates: ["meal"],
    }),
    // Agent-facing (MCP `nutrition`, `meal_recipe`).
    /** One person's daily nutrition, one line per meal plus a daily total. */
    dailyIntake: query({
      description:
        "One person's daily nutrition with one line per meal and a daily total. Defaults to macros: kcal plus protein/carbs/fat/fiber in grams. Set includeFoods for food breakdowns, or nutrition=full for all nutrients. Uses the target meal's household date, including leftovers and unconfirmed entered portions. Future dates are planned; today/past are logged. No assigned intake returns nutrition=null and meals=[]. Nutrient null means unavailable, pending means not calculated, and partial bounds describe only known contributions (not bounds on missing food). Exact values are numbers; ranges retain lower/upper. No cost or preparation detail is included.",
      input: dailyIntakeInput,
      output: dailyIntakeOut,
    }),
    /** `getPreparations` with every totals block trimmed to `nutrition`. */
    preparationsDetail: query({
      description:
        "Recipe preparations made by or served at a meal, including projected and confirmed nutrition. `nutrition` trims every totals block: `full` (default) carries all 22 nutrients, `macros` keeps kcal/protein/carbs/fat/fiber, `kcal` keeps only calories, and `none` keeps cost alone. For per-person daily intake use nutrition_read.daily_intake.",
      input: schemas.getMealPreparationsMcpInput,
      output: schemas.getMealPreparationsMcpOut,
    }),
    /** Plan a recipe into a meal; compact identity + coverage, nutrients on request. */
    planRecipe: mutation({
      description:
        "Plan a recipe into a meal at a scale multiplier (1 = as written). Returns compact meal identity plus cost/kcal coverage. Nutrition defaults to none; request kcal, macros, or full when needed.",
      command: { label: "Plan recipe", confirmation: null },
      input: schemas.mealAddRecipeInput.extend({
        nutrition: addRecipeNutritionDetail,
      }),
      output: planRecipeOut,
      invalidates: ["meal"],
    }),
  },
  { exposure: "capability", mcpToolGroup: "nutrition" },
);
