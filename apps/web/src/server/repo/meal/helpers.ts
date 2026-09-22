import type { DataQuality } from "@cubby/schemas/data-quality";
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
import { type NutritionTotals, withMacros } from "@cubby/schemas/nutrition";
import type { StoredRecipeTotals } from "@cubby/schemas/recipe-shared";

import {
  aggregateTotals,
  pendingTotals,
  scaleTotals,
} from "~/lib/nutrition-estimates";
import {
  mapImages,
  type MappableImageRecord,
} from "~/server/repo/database-helpers";

const scaledRecipeTotals = (
  totals: StoredRecipeTotals | null,
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
      totals: StoredRecipeTotals | null;
      totalsComputedAt: Date | null;
      deletedAt: Date | null;
    };
  }>;
  images: Array<{ image: MappableImageRecord; deletedAt: Date | null }>;
};

export const dbMealToAPI = (
  row: MealRow,
  dataQuality: DataQuality,
): MealOut => {
  const recipes: MealRecipeOut[] = row.recipes
    // `relations.meal.full.recipes` already filters soft-deleted occurrences
    // (`where: notDeleted(mealRecipe)`); the to-one `recipe` join can't be
    // filtered in `with`, so `mr.recipe.deletedAt` is the backstop here.
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
        totals: mr.recipe.totals ? withMacros(mr.recipe.totals) : null,
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
    images: mapImages(row.images),
    dataQuality,
    // `name` is a nullable, user-editable label; an unnamed meal falls back to
    // its date so every surface has a non-blank identity to show.
    displayName: row.name?.trim() || row.date,
    recipeNames: recipes.map((recipe) => recipe.recipe.name),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
