import {
  mealOut,
  mealListItemOut,
  mealFilterFields as mealBaseFilterFields,
} from "@cubby/schemas/entities/meal";
import { mealFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.meal.gen";
import { rawUpcomingMealSummary } from "./meal-raw-read";
import { z } from "zod";

export * from "./meal-nutrition";
export * from "./meal-amount";
import { mealFoodAmount } from "./meal-amount";
import { recipeYieldSchema, recipeRefOut } from "./recipe-shared";
import { uniqueBy } from "./base-entity";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import {
  aggregatedNeedOut,
  needViaOut,
  subRecipeBlockReason,
} from "./availability";
import { amount, dateTime } from "./codec";
import { money } from "./money";
import {
  ledgerPartyShortcode,
  mealRecipeId,
  mealShortcode,
  recipeShortcode,
} from "./identifiers";
import { ledgerPartyPersonSummary } from "./ledger-party-fields";
import { mealKindSchema } from "./meal-classification";
import { mealDate, mealScale, mealYieldGrams } from "./meal-shared";
import {
  nutritionTotals,
  nutritionTotalsPartial,
  measureEstimate,
} from "./nutrition";
export {
  mealRecipeInput,
  type MealRecipeInput,
  scaledTotals,
  type ScaledTotals,
  mealTotals,
  type MealTotals,
} from "./meal-fields";

export {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  type MealKind,
  mealKindSchema,
  mealKindValues,
  type MealType,
  mealTypeRank,
  mealTypeSchema,
  mealTypeValues,
} from "./meal-classification";
export {
  mealDate,
  mealDateRange,
  mealScale,
  mealYieldGrams,
  type MealYieldGrams,
} from "./meal-shared";

/**
 * `mealType` sorts by SLOT, not alphabetically — the repo resolves it through
 * `mealTypeValues`' declaration order, because a raw text sort would put
 * dessert before dinner. Cost is deliberately absent: it's a read-time rollup
 * of current `recipe.totals x scale`; estimate status cannot be represented by
 * a useful SQL sort key.
 */
export type MealSortField = GeneratedEntitySortField<"meal">;

export const mealAddRecipeInput = z.object({
  mealId: mealShortcode,
  recipeId: recipeShortcode.describe("Recipe ID to plan into the meal"),
  scale: mealScale.default(1).describe("Scale multiplier (1 = as written)"),
  convertToCooked: z
    .boolean()
    .optional()
    .describe(
      "Explicitly reviewed conversion to cooked, committed with the recipe addition",
    ),
  sortOrder: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sort order within the meal"),
});

// mealRecipe.id is a declared exception to shortcode-only ids: the meal-recipe
// join row has no shortcode, so agents address it by this raw id.
const mealRecipeOccurrenceId = mealRecipeId.describe(
  "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
);

export const mealUpdateRecipeInput = z.object({
  id: mealRecipeOccurrenceId,
  scale: mealScale.optional().describe("New scale multiplier (e.g. 1.5)"),
  sortOrder: z.number().int().nullable().optional().describe("New sort order"),
});

export const mealRecipeIdInput = z.object({
  id: mealRecipeOccurrenceId,
});

export const mealFilterFields = {
  ...mealBaseFilterFields,
  recipeCostCoverage: z
    .boolean()
    .optional()
    .describe(
      "Meals with a live recipe whose priced ingredients are incomplete.",
    ),
  from: mealDate.optional().describe("Only meals on or after this day"),
  to: mealDate.optional().describe("Only meals on or before this day"),
};

export const mealFiltersSchema = z.object(mealFilterFields);
export type MealFilters = z.infer<typeof mealFiltersSchema>;

export const mealPreparationYieldBasis = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["actual", "estimated", "recipe"]),
    lowerGrams: z.number().positive(),
    upperGrams: z.number().positive().nullable(),
  }),
  z.object({
    kind: z.literal("missing"),
    lowerGrams: z.null(),
    upperGrams: z.null(),
  }),
]);
export type MealPreparationYieldBasis = z.infer<
  typeof mealPreparationYieldBasis
>;

const mealRecipePreparationSetChange = z.object({
  action: z.literal("set"),
  mealId: mealShortcode,
  ledgerPartyId: ledgerPartyShortcode,
  amount: mealFoodAmount,
  confirmed: z.boolean(),
});

const mealRecipePreparationRemoveChange = z.object({
  action: z.literal("remove"),
  mealId: mealShortcode,
  ledgerPartyId: ledgerPartyShortcode,
});

export const mealRecipePreparationChange = z.discriminatedUnion("action", [
  mealRecipePreparationSetChange,
  mealRecipePreparationRemoveChange,
]);
export type MealRecipePreparationChange = z.infer<
  typeof mealRecipePreparationChange
>;

export const getMealPreparationsInput = z.object({
  mealId: mealShortcode,
});
export type GetMealPreparationsInput = z.infer<typeof getMealPreparationsInput>;

export const saveMealRecipePreparationInput = z.object({
  mealRecipeId,
  estimatedYieldGrams: mealYieldGrams.nullable().optional(),
  actualYieldGrams: mealYieldGrams.nullable().optional(),
  changes: z
    .array(mealRecipePreparationChange)
    .refine(
      ...uniqueBy(
        (change: MealRecipePreparationChange) =>
          `${change.mealId}:${change.ledgerPartyId}`,
        "changes must not repeat a target meal and ledger party",
      ),
    ),
});
export type SaveMealRecipePreparationInput = z.infer<
  typeof saveMealRecipePreparationInput
>;

const mealPreparationSourceMealOut = z.object({
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
});

const mealPreparationTargetMealOut = mealPreparationSourceMealOut;

const mealPreparationEaterOut = ledgerPartyPersonSummary;

export const mealRecipePreparationPortionOut = z.object({
  targetMeal: mealPreparationTargetMealOut,
  eater: mealPreparationEaterOut,
  amount: mealFoodAmount,
  grams: z.number().positive().nullable(),
  weight: measureEstimate,
  batchShare: measureEstimate,
  confirmedAt: dateTime.nullable(),
  servedHere: z.boolean(),
  totals: nutritionTotals,
});
export type MealRecipePreparationPortionOut = z.infer<
  typeof mealRecipePreparationPortionOut
>;

const mealRecipePreparationSourceSummaryOut = z.object({
  assignedGrams: z.number().nonnegative().nullable(),
  confirmedGrams: z.number().nonnegative().nullable(),
  assignedShare: measureEstimate,
  // Negative is meaningful: it exposes an over-assigned preparation.
  unassignedGrams: z.number().nullable(),
});

const preparedHereMatchesSourceSummary = [
  (preparation: { preparedHere: boolean; sourceSummary: unknown }) =>
    preparation.preparedHere === (preparation.sourceSummary !== null),
  "sourceSummary is available exactly when the preparation was prepared here",
] as const;

const mealRecipePreparationFields = {
  mealRecipeId,
  preparedHere: z.boolean(),
  sourceMeal: mealPreparationSourceMealOut,
  recipe: recipeRefOut,
  scale: mealScale,
  recipeServings: z.number().positive().nullable(),
  recipeYield: recipeYieldSchema.nullable(),
  estimatedYieldGrams: mealYieldGrams.nullable(),
  actualYieldGrams: mealYieldGrams.nullable(),
  yieldBasis: mealPreparationYieldBasis,
  totals: nutritionTotals,
  sourceSummary: mealRecipePreparationSourceSummaryOut.nullable(),
  portions: z.array(mealRecipePreparationPortionOut),
};

export const mealRecipePreparationOut = z
  .object(mealRecipePreparationFields)
  .refine(...preparedHereMatchesSourceSummary);
export type MealRecipePreparationOut = z.infer<typeof mealRecipePreparationOut>;

const mealPreparationTotalsPartOut = z.object({
  portionCount: z.number().int().nonnegative(),
  totals: nutritionTotals,
});

export const getMealPreparationsOut = z.object({
  mealId: mealShortcode,
  preparations: z.array(mealRecipePreparationOut),
  totals: z.object({
    confirmed: mealPreparationTotalsPartOut,
    projected: mealPreparationTotalsPartOut,
  }),
});
export type GetMealPreparationsOut = z.infer<typeof getMealPreparationsOut>;

export const mealPreparationNutritionDetail = z.enum([
  "full",
  "macros",
  "kcal",
  "none",
]);
export type MealPreparationNutritionDetail = z.infer<
  typeof mealPreparationNutritionDetail
>;

export const getMealPreparationsMcpInput = getMealPreparationsInput.extend({
  nutrition: mealPreparationNutritionDetail.default("full"),
});

/**
 * `nutrition_read.preparations_detail` over MCP: the same shape as {@link getMealPreparationsOut}
 * but every `totals.nutrition` may be a subset of the 22 nutrient keys. One
 * meal read carries (1 + preparations + portions + 2) totals objects; at 22
 * estimates each that was ~10KB to answer "is this portion confirmed?". The
 * HTTP route and the web UI keep the exhaustive shape.
 */
export const getMealPreparationsMcpOut = z.object({
  mealId: mealShortcode,
  preparations: z.array(
    z
      .object({
        ...mealRecipePreparationFields,
        totals: nutritionTotalsPartial,
        portions: z.array(
          mealRecipePreparationPortionOut.extend({
            totals: nutritionTotalsPartial,
          }),
        ),
      })
      .refine(...preparedHereMatchesSourceSummary),
  ),
  totals: z.object({
    confirmed: mealPreparationTotalsPartOut.extend({
      totals: nutritionTotalsPartial,
    }),
    projected: mealPreparationTotalsPartOut.extend({
      totals: nutritionTotalsPartial,
    }),
  }),
});
export type GetMealPreparationsMcpOut = z.infer<
  typeof getMealPreparationsMcpOut
>;

export const saveMealRecipePreparationOut = z.object({
  mealRecipeId,
  estimatedYieldGrams: mealYieldGrams.nullable(),
  actualYieldGrams: mealYieldGrams.nullable(),
  affectedMealIds: z.array(mealShortcode),
});
export type SaveMealRecipePreparationOut = z.infer<
  typeof saveMealRecipePreparationOut
>;

/** List-row projection: `mealOut` plus the server-resolved gallery cover(s). */

/** Generic MCP entity result; MealRecipe rows have no public shortcode. */

export const mealRecipeOut = mealListItemOut.shape.recipes.element;
export const mealRecipeSummary = mealRecipeOut.shape.recipe;
export type MealRecipeOut = z.output<typeof mealRecipeOut>;

export const mealListOut = z.array(mealOut);

export const upcomingMealSummaryOut = rawUpcomingMealSummary
  .omit({ mealType: true, mealKind: true })
  .extend({
    fields: mealFieldEnvelopeSchemas.output.shape.fields.pick({
      mealType: true,
      mealKind: true,
    }),
  })
  .array();
export type UpcomingMealSummaryOut = z.infer<typeof upcomingMealSummaryOut>;

export const shoppingListContribution = z.object({
  mealId: mealShortcode,
  mealName: z.string().nullable(),
  date: mealDate,
  recipeId: recipeShortcode,
  recipeName: z.string(),
  scale: mealScale,
  needValue: z.number().nullable(),
  amount: amount.nullable(),
  lineIndex: z.number().int().nonnegative(),
  via: z.array(needViaOut),
});
export type ShoppingListContribution = z.infer<typeof shoppingListContribution>;

/**
 * A sub-recipe whose ingredients are NOT in `items`. Server-enforced disclosure
 * of a real omission — deliberately its own channel rather than a pseudo-item,
 * which would sort to the bottom of a shortfall-ordered list and read as "fine".
 */
export const unexpandedSubRecipeOut = z.object({
  recipeId: recipeShortcode,
  name: z.string(),
  reason: subRecipeBlockReason,
  amount: amount.nullable(),
  via: z.array(needViaOut),
  mealId: mealShortcode,
  mealName: z.string().nullable(),
  date: mealDate,
  parentRecipeId: recipeShortcode,
  parentRecipeName: z.string(),
  lineIndex: z.number().int().nonnegative(),
});
export type UnexpandedSubRecipe = z.infer<typeof unexpandedSubRecipeOut>;

export const shoppingListInput = z.object({
  from: mealDate,
  to: mealDate,
  excludedMealIds: z.array(mealShortcode).optional(),
});

export const shoppingListItem = aggregatedNeedOut
  .omit({ sources: true })
  .extend({
    membership: z.enum(["buy", "usuallyOnHand", "covered"]),
    perMeal: z.array(shoppingListContribution),
  });
export type ShoppingListItem = z.infer<typeof shoppingListItem>;

export const shoppingListOut = z.object({
  from: mealDate,
  to: mealDate,
  meals: z.array(
    z.object({
      id: mealShortcode,
      name: z.string().nullable(),
      date: mealDate,
    }),
  ),
  items: z.array(shoppingListItem),
  /**
   * Sum of priced buy rows only. `pricedItems` vs the buy-row count makes
   * it honest — a partial estimate must not read as the whole trip's cost.
   */
  estimatedTotal: money,
  pricedItems: z.number().int(),
  /** Sub-recipes whose ingredients this list could NOT account for. */
  unexpanded: z.array(unexpandedSubRecipeOut),
  /**
   * Meals inside the range that contribute nothing because of their
   * `mealKind` — you aren't shopping for a night you're eating out, and a
   * leftovers night's ingredients were bought when the meal was first cooked.
   * Disclosed rather than silently dropped: a renderer-intrinsic omission has
   * to be visible, or the list reads as complete when it isn't.
   */
  omittedMeals: z.array(
    z.object({
      id: mealShortcode,
      name: z.string().nullable(),
      date: mealDate,
      omission: z.object({
        reason: mealKindSchema.exclude(["cooked"]),
        label: z.string(),
      }),
    }),
  ),
});
export type ShoppingListOut = z.infer<typeof shoppingListOut>;

/** The report block key prefix of one prepared recipe's portions, followed by its mealRecipeId. */
export const MEAL_PORTIONS_BLOCK_KEY = "portions:";
