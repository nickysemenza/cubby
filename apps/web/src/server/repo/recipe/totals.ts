/**
 * Persistence + invalidation for precomputed recipe totals (cost/calories).
 * Totals live in the `Recipe.totals` jsonb; `totalsComputedAt IS NULL` marks a
 * row stale. Marking is event-driven (recipe/product writes); recompute is done
 * by the presence-driven drain. See recipe-costing.service.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Persist a recipe's computed totals. Stamps it fresh unless `stale` is set —
 * stale leaves `totalsComputedAt` NULL so the drain retries (used when the USDA
 * enrichment was incomplete, e.g. a cold backend), while still writing the
 * best-effort blob so the UI shows something rather than a perpetual skeleton.
 */
export const updateRecipeTotals = async (
  db: Database,
  id: RecipeId,
  totals: RecipeTotals,
  opts?: { stale?: boolean },
): Promise<void> => {
  await getDb(db)
    .update(recipe)
    .set({ totals, totalsComputedAt: opts?.stale ? null : new Date() })
    .where(eq(recipe.id, id));
};

/** Mark recipes stale (keep the last-known totals; just clear the timestamp). */
export const markRecipesStale = async (
  db: Database,
  ids: RecipeId[],
): Promise<void> => {
  if (ids.length === 0) return;
  await getDb(db)
    .update(recipe)
    .set({ totalsComputedAt: null })
    .where(inArray(recipe.id, ids));
};

/** Ids of stale (never-computed / invalidated) recipes, for the drain. */
export const selectStaleRecipeIds = async (
  db: Database,
  limit: number,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .select({ id: recipe.id })
    .from(recipe)
    .where(and(notDeleted(recipe), isNull(recipe.totalsComputedAt)))
    .limit(limit);
  return rows.map((r) => r.id as RecipeId);
};

/** All active recipe ids — for a full backfill/recompute. */
export const selectAllActiveRecipeIds = async (
  db: Database,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .select({ id: recipe.id })
    .from(recipe)
    .where(notDeleted(recipe));
  return rows.map((r) => r.id as RecipeId);
};

/** How many recipes still need (re)computing. */
export const countStaleRecipes = async (db: Database): Promise<number> => {
  const [row] = await getDb(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(recipe)
    .where(and(notDeleted(recipe), isNull(recipe.totalsComputedAt)));
  return row?.count ?? 0;
};

/**
 * Recipes that reference an ingredient (via any section). Used to invalidate when
 * a product's price/USDA link/ingredient changes (a product feeds recipe cost via
 * its linked ingredient).
 */
export const findRecipeIdsUsingIngredient = async (
  db: Database,
  ingredientId: string,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .where(eq(recipeSectionIngredient.ingredientId, ingredientId));
  return rows.map((r) => r.recipeId as RecipeId);
};

/**
 * Parent recipes that use the given recipe as a sub-recipe (recipe-as-ingredient
 * is modelled as an ingredient row whose `recipeId` points at the sub-recipe).
 */
export const findParentRecipeIds = async (
  db: Database,
  subRecipeId: RecipeId,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .innerJoin(
      ingredient,
      eq(recipeSectionIngredient.ingredientId, ingredient.id),
    )
    .where(eq(ingredient.recipeId, subRecipeId));
  return rows.map((r) => r.recipeId as RecipeId);
};
