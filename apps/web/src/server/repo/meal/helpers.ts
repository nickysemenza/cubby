import {
  type MealId,
  type RecipeId,
  unsafeMealShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import type {
  MealKind,
  MealOut,
  MealRecipeOut,
  MealTotals,
  MealType,
} from "@cubby/schemas/meal";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";

/**
 * Scale a recipe's persisted totals by a meal-recipe multiplier. Totals are
 * linear in scale, so this is a plain multiply — no costing recompute. Returns
 * null when the recipe has no totals yet (caller shows "pending", never 0).
 */
const scaleTotals = (
  totals: RecipeTotals | null | undefined,
  scale: number,
): MealRecipeOut["scaledTotals"] => {
  if (!totals) return null;
  return {
    costTotal: totals.costTotal * scale,
    ...(totals.costTotalUpper != null
      ? { costTotalUpper: totals.costTotalUpper * scale }
      : {}),
    caloriesTotal: totals.caloriesTotal * scale,
    ...(totals.caloriesTotalUpper != null
      ? { caloriesTotalUpper: totals.caloriesTotalUpper * scale }
      : {}),
  };
};

/**
 * Roll up a meal's recipes into a single cost/calorie total. `pending` is true
 * when any recipe lacks totals, so the UI can show the rollup as provisional
 * rather than silently undercounting. Upper bounds fall back to the point value
 * for recipes without a range, and are only surfaced when at least one recipe
 * actually has an upper bound.
 */
const rollupMealTotals = (recipes: MealRecipeOut[]): MealTotals => {
  let costTotal = 0;
  let caloriesTotal = 0;
  let costUpper = 0;
  let caloriesUpper = 0;
  let anyCostUpper = false;
  let anyCaloriesUpper = false;
  let pending = false;

  for (const r of recipes) {
    const t = r.scaledTotals;
    if (!t) {
      pending = true;
      continue;
    }
    costTotal += t.costTotal;
    caloriesTotal += t.caloriesTotal;
    costUpper += t.costTotalUpper ?? t.costTotal;
    caloriesUpper += t.caloriesTotalUpper ?? t.caloriesTotal;
    if (t.costTotalUpper != null) anyCostUpper = true;
    if (t.caloriesTotalUpper != null) anyCaloriesUpper = true;
  }

  return {
    costTotal,
    caloriesTotal,
    pending,
    ...(anyCostUpper ? { costTotalUpper: costUpper } : {}),
    ...(anyCaloriesUpper ? { caloriesTotalUpper: caloriesUpper } : {}),
  };
};

/** Shape of a meal row loaded with `relations.meal.full`. */
type MealRow = {
  id: MealId;
  shortcode: string;
  date: string; // "YYYY-MM-DD" (date column, mode:"string")
  name: string | null;
  sortOrder: number | null;
  mealType: MealType | null;
  mealKind: MealKind;
  createdAt: Date;
  updatedAt: Date;
  recipes: Array<{
    id: MealRecipeOut["id"];
    mealId: MealId;
    recipeId: RecipeId;
    scale: number;
    sortOrder: number | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    recipe: {
      id: RecipeId;
      shortcode: string;
      name: string;
      servings: number | null;
      yield: MealRecipeOut["recipe"]["yield"];
      totals: RecipeTotals | null;
      deletedAt: Date | null;
    };
  }>;
};

export const dbMealToAPI = (row: MealRow): MealOut => {
  const recipes: MealRecipeOut[] = row.recipes
    // Drizzle can't filter soft-deleted rows inside `with`; do it here.
    //
    // Both deletedAts are load-bearing and mean different things: the LINK's
    // says the recipe was unplanned from this meal, the RECIPE's says it no
    // longer exists at all. deleteRecipes now cascades the link, so the second
    // check is defense-in-depth for rows written before that — but it's the one
    // that was missing, and it let a deleted recipe keep rendering in the meal
    // and keep summing its stale persisted totals into rollupMealTotals with
    // pending:false, i.e. a wrong number that reads as trustworthy.
    .filter((mr) => mr.deletedAt === null && mr.recipe.deletedAt === null)
    .map((mr) => ({
      id: mr.id,
      mealId: unsafeMealShortcode(row.shortcode),
      recipeId: unsafeRecipeShortcode(mr.recipe.shortcode),
      recipe: {
        id: unsafeRecipeShortcode(mr.recipe.shortcode),
        name: mr.recipe.name,
        servings: mr.recipe.servings,
        yield: mr.recipe.yield,
        totals: mr.recipe.totals,
      },
      scale: mr.scale,
      sortOrder: mr.sortOrder,
      scaledTotals: scaleTotals(mr.recipe.totals, mr.scale),
      createdAt: mr.createdAt,
      updatedAt: mr.updatedAt,
    }));

  return {
    id: unsafeMealShortcode(row.shortcode),
    date: row.date,
    name: row.name,
    sortOrder: row.sortOrder,
    mealType: row.mealType,
    mealKind: row.mealKind,
    recipes,
    totals: rollupMealTotals(recipes),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
