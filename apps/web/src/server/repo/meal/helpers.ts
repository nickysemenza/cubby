import {
  type MealId,
  parseShortcodeFor,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import type {
  MealKind,
  MealOut,
  MealRecipeOut,
  MealType,
} from "@cubby/schemas/meal";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";

import { aggregateTotals, scaleTotals } from "~/lib/nutrition-estimates";

const pendingTotals = (
  reason: "totals_missing" | "totals_stale",
): NutritionTotals => {
  const estimate = { status: "pending" as const, reason };
  return { cost: estimate, nutrition: buildNutrition(() => estimate) };
};

const scaledRecipeTotals = (
  totals: RecipeTotals | null,
  totalsComputedAt: Date | null,
  scale: number,
): NutritionTotals => {
  if (!totals) return pendingTotals("totals_missing");
  if (!totalsComputedAt) return pendingTotals("totals_stale");
  return scaleTotals(totals, scale);
};

/** Shape of a meal row loaded with `relations.meal.full`. */
type MealRow = {
  id: MealId;
  shortcode: string;
  date: string;
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
    estimatedYieldGrams: number | null;
    actualYieldGrams: number | null;
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
      totalsComputedAt: Date | null;
      deletedAt: Date | null;
    };
  }>;
};

export const dbMealToAPI = (row: MealRow): MealOut => {
  const recipes: MealRecipeOut[] = row.recipes
    // Drizzle can't filter soft-deleted rows inside `with`; both the occurrence
    // and its recipe must still be live before contributing to the meal.
    .filter((mr) => mr.deletedAt === null && mr.recipe.deletedAt === null)
    .map((mr) => ({
      id: mr.id,
      mealId: parseShortcodeFor("meal", row.shortcode),
      recipeId: parseShortcodeFor("recipe", mr.recipe.shortcode),
      estimatedYieldGrams: mr.estimatedYieldGrams,
      actualYieldGrams: mr.actualYieldGrams,
      recipe: {
        id: parseShortcodeFor("recipe", mr.recipe.shortcode),
        name: mr.recipe.name,
        servings: mr.recipe.servings,
        yield: mr.recipe.yield,
        totals: mr.recipe.totals,
      },
      scale: mr.scale,
      sortOrder: mr.sortOrder,
      scaledTotals: scaledRecipeTotals(
        mr.recipe.totals,
        mr.recipe.totalsComputedAt,
        mr.scale,
      ),
      createdAt: mr.createdAt,
      updatedAt: mr.updatedAt,
    }));

  return {
    id: parseShortcodeFor("meal", row.shortcode),
    date: row.date,
    name: row.name,
    sortOrder: row.sortOrder,
    mealType: row.mealType,
    mealKind: row.mealKind,
    recipes,
    totals: aggregateTotals(recipes.map((recipe) => recipe.scaledTotals)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
