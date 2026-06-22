/**
 * Persistence + invalidation for precomputed recipe totals (cost/calories).
 * Totals live in the `Recipe.totals` jsonb; `totalsComputedAt IS NULL` marks a
 * row stale. Marking is event-driven (recipe/product writes); recompute is done
 * by the presence-driven drain. See recipe-costing.service.
 */

import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe";
import { and, eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { TraceNames, withTrace } from "~/server/tracing";

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

/** Persisted totals state for one recipe (explain endpoint). Null = not found. */
export const getRecipeTotalsState = async (
  db: Database,
  id: RecipeId,
): Promise<{
  totals: RecipeTotals | null;
  totalsComputedAt: Date | null;
} | null> =>
  withTrace(TraceNames.db("recipe.getRecipeTotalsState"), async (span) => {
    span.setAttribute("db.table", "recipe");
    const [row] = await getDb(db)
      .select({
        totals: recipe.totals,
        totalsComputedAt: recipe.totalsComputedAt,
      })
      .from(recipe)
      .where(and(eq(recipe.id, id), notDeleted(recipe)))
      .limit(1);
    return row ?? null;
  });

/** All active recipe ids — for a full backfill/recompute. */
export const selectAllActiveRecipeIds = async (
  db: Database,
): Promise<RecipeId[]> =>
  withTrace(TraceNames.db("recipe.selectAllActiveRecipeIds"), async (span) => {
    span.setAttribute("db.table", "recipe");
    const rows = await getDb(db)
      .select({ id: recipe.id })
      .from(recipe)
      .where(notDeleted(recipe));
    span.setAttribute("db.result_count", rows.length);
    return rows.map((r) => r.id as RecipeId);
  });

/**
 * Recipes that reference an ingredient (via any section). Used to invalidate when
 * a product's price/USDA link/ingredient changes (a product feeds recipe cost via
 * its linked ingredient).
 */
export const findRecipeIdsUsingIngredient = async (
  db: Database,
  ingredientId: IngredientId,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .where(eq(recipeSectionIngredient.ingredientId, ingredientId));
  return rows.map((r) => r.recipeId);
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
