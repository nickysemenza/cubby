import type { DataQuality } from "@cubby/schemas/data-quality";
import {
  type MealId,
  parseShortcodeFor,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import { mealOut } from "@cubby/schemas/meal";
import type {
  MealKind,
  MealOut,
  MealRecipeOut,
  MealType,
} from "@cubby/schemas/meal";
import {
  type NutritionTotals,
  totalsPreview,
  withMacros,
} from "@cubby/schemas/nutrition";
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
import { mealCostLabel } from "~/server/repo/list-display-labels";
import {
  type ListProjection,
  wantsListGroup,
} from "~/server/repo/list-projection";

const scaledRecipeTotals = (
  totals: StoredRecipeTotals | null,
  totalsComputedAt: Date | null,
  scale: number,
): NutritionTotals => {
  if (!totals) return pendingTotals("totals_missing");
  if (!totalsComputedAt) return pendingTotals("totals_stale");
  return scaleTotals(totals, scale);
};

type PlannedRecipeForTotals = {
  deletedAt: Date | null;
  scale: number;
  recipe: {
    deletedAt: Date | null;
    totals: StoredRecipeTotals | null;
    totalsComputedAt: Date | null;
  };
};

/** Soft-deleted associations and Recipes never contribute to Meal totals. */
const livePlannedRecipes = <T extends PlannedRecipeForTotals>(
  recipes: readonly T[],
): T[] =>
  recipes.filter(
    (entry) => entry.deletedAt === null && entry.recipe.deletedAt === null,
  );

/** Compact Home totals use the same live-recipe scaling as the full projection. */
export const rollupMealTotals = (
  recipes: readonly PlannedRecipeForTotals[],
): NutritionTotals =>
  aggregateTotals(
    livePlannedRecipes(recipes).map((entry) =>
      scaledRecipeTotals(
        entry.recipe.totals,
        entry.recipe.totalsComputedAt,
        entry.scale,
      ),
    ),
  );

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

export const dbMealListReadProjection = (
  row: MealRow,
  projection: ListProjection,
): Partial<MealOut> & Pick<MealOut, "id"> => {
  const recipes: MealRecipeOut[] = livePlannedRecipes(
    wantsListGroup(projection, "relations") ||
      wantsListGroup(projection, "derived")
      ? row.recipes
      : [],
  )
    // `relations.meal.full.recipes` already filters soft-deleted occurrences
    // (`where: notDeleted(mealRecipe)`); the to-one `recipe` join can't be
    // filtered in `with`, so `mr.recipe.deletedAt` is the backstop here.
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

  const totals = wantsListGroup(projection, "derived")
    ? aggregateTotals(recipes.map((recipe) => recipe.scaledTotals))
    : undefined;
  const result: Partial<MealOut> & Pick<MealOut, "id"> = {
    id: parseShortcodeFor("meal", row.shortcode),
    date: row.date,
    name: row.name,
    sortOrder: row.sortOrder,
    mealType: row.mealType,
    mealKind: row.mealKind,
    // An unnamed meal's identity is its date, as in the full projection.
    displayName: row.name?.trim() || row.date,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (wantsListGroup(projection, "relations"))
    Object.assign(result, {
      recipes,
      recipeNames: recipes.map((recipe) => recipe.recipe.name),
    });
  if (totals)
    Object.assign(result, {
      totals,
      ...totalsPreview(totals),
      costTotalLabel: mealCostLabel(totals.cost),
    });
  if (wantsListGroup(projection, "media"))
    result.images = mapImages(row.images);
  return result;
};

export const dbMealToAPI = (row: MealRow, dataQuality: DataQuality): MealOut =>
  mealOut.parse({
    ...dbMealListReadProjection(row, { kind: "full" }),
    dataQuality,
  });
