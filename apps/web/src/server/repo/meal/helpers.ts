import type { MealOut, MealRecipeOut, MealTotals } from "@cubby/schemas/meal";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";

/**
 * Scale a recipe's persisted totals by a meal-recipe multiplier. Totals are
 * linear in scale, so this is a plain multiply — no costing recompute. Returns
 * null when the recipe has no totals yet (caller shows "pending", never 0).
 */
export const scaleTotals = (
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
export const rollupMealTotals = (recipes: MealRecipeOut[]): MealTotals => {
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
  id: MealOut["id"];
  date: string; // "YYYY-MM-DD" (date column, mode:"string")
  name: string | null;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
  recipes: Array<{
    id: MealRecipeOut["id"];
    mealId: MealOut["id"];
    recipeId: MealRecipeOut["recipeId"];
    scale: number;
    sortOrder: number | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    recipe: {
      id: MealRecipeOut["recipeId"];
      name: string;
      servings: number | null;
      yield: MealRecipeOut["recipe"]["yield"];
      totals: RecipeTotals | null;
    };
  }>;
};

export const dbMealToAPI = (row: MealRow): MealOut => {
  const recipes: MealRecipeOut[] = row.recipes
    // Drizzle can't filter soft-deleted rows inside `with`; do it here.
    .filter((mr) => mr.deletedAt === null)
    .map((mr) => ({
      id: mr.id,
      mealId: mr.mealId,
      recipeId: mr.recipeId,
      recipe: {
        id: mr.recipe.id,
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
    id: row.id,
    date: row.date,
    name: row.name,
    sortOrder: row.sortOrder,
    recipes,
    totals: rollupMealTotals(recipes),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
