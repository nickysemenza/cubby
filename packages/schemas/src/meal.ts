import { z } from "zod";
export * from "./meal-nutrition";
export * from "./meal-amount";
import { mealFoodAmount } from "./meal-amount";
import { recipeYieldSchema } from "./recipe-shared";
import { auditDateFilterFields, uniqueBy } from "./base-entity";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { mealRelatedFilterFields } from "./related-view";
import {
  aggregatedNeedOut,
  needViaOut,
  subRecipeBlockReason,
} from "./availability";
import { amount } from "./codec";
import { displayImagesField } from "./display-images";
import { money } from "./money";
import {
  ledgerPartyShortcode,
  mealRecipeId,
  mealShortcode,
  recipeShortcode,
} from "./identifiers";
import { ledgerPartyKind } from "./ledger-party";
import { mealKindSchema, mealTypeSchema } from "./meal-classification";
import { mealDate, mealScale, mealYieldGrams } from "./meal-shared";
import {
  nutritionTotals,
  nutritionTotalsPartial,
  measureEstimate,
} from "./nutrition";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import { mealRecipeOut, mealTotals } from "./meal-fields";
import {
  generatedMealFieldSchemas,
  generatedMealFilterFields,
} from "./generated/entity-field-schemas.meal.gen";
export {
  mealRecipeInput,
  type MealRecipeInput,
  scaledTotals,
  type ScaledTotals,
  mealRecipeSummary,
  mealRecipeOut,
  type MealRecipeOut,
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

export const mealCreateInput = z.object(generatedMealFieldSchemas.create);
export type MealCreateInput = z.infer<typeof mealCreateInput>;

export const mealUpdateData = z.object(generatedMealFieldSchemas.update);
export const mealUpdateInput = z.object({
  id: mealShortcode,
  data: mealUpdateData,
});
export type MealUpdateInput = z.infer<typeof mealUpdateInput>;

export const mealAddRecipeInput = z.object({
  mealId: mealShortcode,
  recipeId: recipeShortcode.describe("Recipe ID to plan into the meal"),
  scale: mealScale.default(1).describe("Scale multiplier (1 = as written)"),
  sortOrder: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sort order within the meal"),
});

export const mealUpdateRecipeInput = z.object({
  id: mealRecipeId,
  scale: mealScale.optional(),
  sortOrder: z.number().int().nullable().optional(),
});

export const mealRecipeIdInput = z.object({
  id: mealRecipeId,
});

export const mealFilterFields = {
  ...auditDateFilterFields,
  ...generatedMealFilterFields,
  /**
   * `meal.mealType` is nullable, so `"none"` is the unslotted worklist. OR-ed
   * with `mealType` rather than narrowing it (see
   * `taskFilterFields.projectPresenceFilter`).
   */
  mealTypePresenceFilter: presenceFilter,
  recipeCostCoverage: z
    .enum(["understated"])
    .optional()
    .describe(
      "Meals with a live recipe whose priced ingredients are incomplete.",
    ),
  from: mealDate.optional().describe("Only meals on or after this day"),
  to: mealDate.optional().describe("Only meals on or before this day"),
  ...mealRelatedFilterFields,
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

const mealPreparationTargetMealOut = mealPreparationSourceMealOut.extend({
  mealKind: mealKindSchema,
});

const mealPreparationEaterOut = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
  kind: ledgerPartyKind.exclude(["household"]),
});

export const mealRecipePreparationPortionOut = z.object({
  targetMeal: mealPreparationTargetMealOut,
  eater: mealPreparationEaterOut,
  amount: mealFoodAmount,
  grams: z.number().positive().nullable(),
  weight: measureEstimate,
  batchShare: measureEstimate,
  confirmedAt: z.date().nullable(),
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
  recipe: z.object({ id: recipeShortcode, name: z.string() }),
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
 * `get_meal_preparations` over MCP: the same shape as {@link getMealPreparationsOut}
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

const mealOutFields = generatedMealFieldSchemas.read;

export const mealOut = z.object(mealOutFields);
export type MealOut = z.infer<typeof mealOut>;

/** List-row projection: `mealOut` plus the server-resolved gallery cover(s). */
export const mealListItemOut = mealOut.extend({
  displayImages: displayImagesField,
});
export type MealListItemOut = z.infer<typeof mealListItemOut>;

/** Generic MCP entity result; MealRecipe rows have no public shortcode. */
export const mealMcpEntityOut = mealOut.extend({
  recipes: z.array(mealRecipeOut.omit({ id: true })),
});

/**
 * Slim MCP projection of a meal row: built from the same field map as
 * `mealOut` minus its audit timestamps, so it cannot drift from the plain
 * shape. Each entry in `recipes` is a full `mealRecipeOut` — its `id` is the
 * mealRecipe row id (the one `update_meal_recipe`/`remove_meal_recipe` take)
 * and the recipe's own name lives at `recipes[].recipe.name`.
 */
export const mealMcpOut = z.object({
  id: mealOutFields.id,
  date: mealOutFields.date,
  name: mealOutFields.name,
  sortOrder: mealOutFields.sortOrder,
  mealType: mealOutFields.mealType,
  mealKind: mealOutFields.mealKind,
  recipes: mealOutFields.recipes,
  totals: mealOutFields.totals,
  recipeNames: mealOutFields.recipeNames,
});
export type MealMcpOut = z.infer<typeof mealMcpOut>;

export const mealMcpListOut = createPaginatedResponseSchema(mealMcpOut);

export const mealListOut = z.array(mealOut);

export const upcomingMealSummaryOut = z.array(
  z.object({
    id: mealShortcode,
    date: mealDate,
    name: z.string().nullable(),
    mealType: mealTypeSchema.nullable(),
    mealKind: mealKindSchema,
    totals: mealTotals,
  }),
);
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
      mealKind: mealKindSchema,
    }),
  ),
});
export type ShoppingListOut = z.infer<typeof shoppingListOut>;
