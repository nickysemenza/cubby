import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { mealRelatedFilterFields } from "./related-view";
import {
  ingredientAvailabilityStatus,
  needViaOut,
  subRecipeBlockReason,
} from "./availability";
import { amount } from "./codec";
import { money, moneyNullable } from "./money";
import {
  ingredientShortcode,
  mealRecipeId,
  mealShortcode,
  recipeShortcode,
} from "./identifiers";
import { mealKindSchema, mealTypeSchema } from "./meal-classification";
import { mealDate, mealScale } from "./meal-shared";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import {
  costCalorieTotals,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

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
export { mealDate, mealDateRange, mealScale } from "./meal-shared";

/**
 * `mealType` sorts by SLOT, not alphabetically — the repo resolves it through
 * `mealTypeValues`' declaration order, because a raw text sort would put
 * dessert before dinner. Cost is deliberately absent: it's a read-time rollup
 * of `recipe.totals x scale` with a `pending` flag, so any SQL ordering would
 * rank a pending meal by a number the page never shows.
 */
export const mealSortableFields = [
  "date",
  "name",
  "mealType",
  "createdAt",
  "updatedAt",
] as const;

export type MealSortField = (typeof mealSortableFields)[number];

export const mealRecipeInput = z.object({
  recipeId: recipeShortcode.describe("Recipe ID to plan into the meal"),
  scale: mealScale.default(1).describe("Scale multiplier (1 = as written)"),
  sortOrder: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Sort order within the meal"),
});
export type MealRecipeInput = z.infer<typeof mealRecipeInput>;

const mealCreateFields = {
  date: mealDate,
  name: z.string().nullable().optional(),
  sortOrder: z.number().int().nullable().optional(),
  mealType: mealTypeSchema
    .nullable()
    .optional()
    .describe(
      "Which eating occasion of the day this is. Null when unslotted; the planning calendar orders a day's meals by it.",
    ),
  mealKind: mealKindSchema
    .optional()
    .describe(
      "How the meal is eaten. Defaults to `cooked`. Use `eating_out`/`takeout` for a placeholder meal that intentionally has no recipes; only `cooked` meals feed the shopping list.",
    ),
  recipes: z.array(mealRecipeInput).optional(),
};
export const mealCreateInput = z.object(mealCreateFields);
export type MealCreateInput = z.infer<typeof mealCreateInput>;

export const mealUpdateData = deriveUpdateData(mealCreateFields, {
  omit: ["recipes"],
});
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
  mealType: oneOrMany(mealTypeSchema).optional(),
  /**
   * `meal.mealType` is nullable, so `"none"` is the unslotted worklist. OR-ed
   * with `mealType` rather than narrowing it (see
   * `taskFilterFields.projectPresenceFilter`).
   */
  mealTypePresenceFilter: presenceFilter,
  mealKind: oneOrMany(mealKindSchema).optional(),
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

export const scaledTotals = costCalorieTotals;
export type ScaledTotals = z.infer<typeof scaledTotals>;

/** A recipe as summarized inside a meal (no ingredient graph). */
export const mealRecipeSummary = z.object({
  id: recipeShortcode,
  name: z.string(),
  servings: z.number().nullish(),
  yield: recipeYieldSchema.nullish(),
  totals: recipeTotals.nullish(),
});

export const mealRecipeOut = z.object({
  id: mealRecipeId,
  mealId: mealShortcode,
  recipeId: recipeShortcode,
  recipe: mealRecipeSummary,
  scale: mealScale,
  sortOrder: z.number().int().nullable(),
  /** recipe.totals x scale, or null when totals are absent/stale. */
  scaledTotals: scaledTotals.nullable(),
  ...timestampedFields,
});
export type MealRecipeOut = z.infer<typeof mealRecipeOut>;

export const mealTotals = z.object({
  costTotal: money,
  costTotalUpper: money.optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
  pending: z.boolean(),
});
export type MealTotals = z.infer<typeof mealTotals>;

const mealOutFields = {
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  mealType: mealTypeSchema.nullable(),
  mealKind: mealKindSchema,
  recipes: z.array(mealRecipeOut),
  totals: mealTotals,
  ...timestampedFields,
};

export const mealOut = z.object(mealOutFields);
export type MealOut = z.infer<typeof mealOut>;

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
  needValue: z.number(),
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

export const shoppingListItem = z.object({
  ingredientId: ingredientShortcode.nullable(),
  name: z.string(),
  basisUnit: z.string().nullable(),
  /** Total need across all meals in range (sum of scaled needs). */
  needValue: z.number(),
  haveValue: z.number().nullable(),
  /**
   * What you still need to buy. **Null when on-hand is unknown** (units that
   * don't reconcile): claiming a shortfall equal to the whole need asserts a
   * quantity we don't have, and sorts an invented number to the top.
   */
  shortfall: z.number().nullable(),
  status: ingredientAvailabilityStatus,
  estimatedCost: moneyNullable,
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
   * Sum of the priced shortfalls. `pricedItems` vs `items.length` is what makes
   * it honest — a total over half the list must not read as the trip's cost.
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
