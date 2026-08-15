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

/**
 * Meal-planning schemas. A `meal` is a planned eating occasion on a calendar day
 * that groups one or more recipes (`mealRecipe`), each at a numeric `scale`
 * multiplier. Cost/calorie rollups are derived read-time from `recipe.totals ×
 * scale` (totals are linear in scale) — nothing is denormalized onto the tables.
 */

/** A recipe to plan into a meal. */
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

const mealCreateShape = {
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
  // Optional: create a meal with its recipes in one call.
  recipes: z.array(mealRecipeInput).optional(),
};
export const mealCreateInput = z.object(mealCreateShape);
export type MealCreateInput = z.infer<typeof mealCreateInput>;

/** Mutable meal fields (recipes are managed via addRecipe/updateRecipe/removeRecipe). */
export const mealUpdateData = deriveUpdateData(mealCreateShape, {
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
  from: mealDate.optional().describe("Only meals on or after this day"),
  to: mealDate.optional().describe("Only meals on or before this day"),
  ...mealRelatedFilterFields,
};

export const mealFiltersSchema = z.object(mealFilterFields);
export type MealFilters = z.infer<typeof mealFiltersSchema>;

/** Cost/calorie totals scaled by a meal-recipe's multiplier. */
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

/** Roll-up across a meal's recipes. `pending` means at least one recipe lacked totals. */
export const mealTotals = z.object({
  costTotal: z.number(),
  costTotalUpper: z.number().optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
  pending: z.boolean(),
});
export type MealTotals = z.infer<typeof mealTotals>;

export const mealOut = z.object({
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  mealType: mealTypeSchema.nullable(),
  mealKind: mealKindSchema,
  recipes: z.array(mealRecipeOut),
  totals: mealTotals,
  ...timestampedFields,
});
export type MealOut = z.infer<typeof mealOut>;

const mealMcpRecipeFields = {
  // mealRecipe row id — declared exception, no shortcode; stays uuid.
  id: mealRecipeId,
  recipeId: recipeShortcode,
  name: z.string().nullable(),
  scale: mealScale,
  scaledTotals: scaledTotals.nullable(),
};

/** Slim MCP projection of a meal row. */
export const mealMcpOut = z.object({
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  mealType: mealTypeSchema.nullable(),
  mealKind: mealKindSchema,
  totals: mealTotals,
  recipes: z.array(z.object(mealMcpRecipeFields)),
});
export type MealMcpOut = z.infer<typeof mealMcpOut>;

export const mealMcpListOut = createPaginatedResponseSchema(mealMcpOut);

export const mealListOut = z.array(mealOut);

/** Which meal/recipe contributed how much of an item's total need. */
export const shoppingListContribution = z.object({
  mealId: mealShortcode,
  mealName: z.string().nullable(),
  date: mealDate,
  recipeId: recipeShortcode,
  recipeName: z.string(),
  scale: mealScale,
  /** This contribution's need, in the item's `basisUnit`. */
  needValue: z.number(),
  /**
   * Index into this response's own planned-line list — stable for the lifetime
   * of one response, which is exactly as long as a matrix column needs. Without
   * it a meal that plans the same recipe twice (two half-batches at different
   * scales) collapses into a single indistinguishable column.
   */
  lineIndex: z.number().int().nonnegative(),
  /** Sub-recipe chain this contribution came through; empty when direct. */
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
  /** The planned line this gap belongs to — a matrix column key. */
  lineIndex: z.number().int().nonnegative(),
});
export type UnexpandedSubRecipe = z.infer<typeof unexpandedSubRecipeOut>;

export const shoppingListItem = z.object({
  ingredientId: ingredientShortcode.nullable(),
  name: z.string(),
  /** Unit `needValue`/`haveValue` are expressed in: grams when convertible, else the need's own unit. */
  basisUnit: z.string().nullable(),
  /** Total need across all meals in range (sum of scaled needs). */
  needValue: z.number(),
  /** On-hand inventory, counted once for the ingredient; null if unconvertible. */
  haveValue: z.number().nullable(),
  /** max(0, need - have). */
  /**
   * What you still need to buy. **Null when on-hand is unknown** (units that
   * don't reconcile): claiming a shortfall equal to the whole need asserts a
   * quantity we don't have, and sorts an invented number to the top.
   */
  shortfall: z.number().nullable(),
  status: ingredientAvailabilityStatus,
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
