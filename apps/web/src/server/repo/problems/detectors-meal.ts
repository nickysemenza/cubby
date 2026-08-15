/**
 * Meal-centric Problems detectors.
 *
 * These exist because `mealKind` made them expressible. Before it, a meal with
 * no recipes was ambiguous — an unfinished plan and a deliberate eating-out
 * placeholder were the same row — so "empty meal" could not be stated as a
 * defect without also accusing every correct placeholder.
 */

import { unsafeMealShortcode } from "@cubby/schemas/identifiers";
import type { EmptyCookedMeal } from "@cubby/schemas/problems";
import { and, asc, eq, notExists } from "drizzle-orm";
import type { Database } from "~/server/db";
import { meal, mealRecipe, recipe } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Live meals whose kind says they'll be cooked but that have no live planned
 * recipe — the half-finished state: on the calendar, nothing chosen.
 *
 * Scoped to `cooked` on purpose. An `eating_out`/`takeout` meal with no
 * recipes is a complete record, and `leftovers` is recipe-optional by nature
 * (its ingredients were bought when the meal was first cooked, which is why
 * `contributesToShoppingList` excludes it too).
 *
 * The subquery needs BOTH soft-delete guards. Unplanning a recipe soft-deletes
 * the `MealRecipe` link, while deleting the recipe leaves the link intact —
 * `dbMealToAPI` filters on both, so a meal whose only recipe was deleted
 * renders as empty. Checking just the link would leave that meal unflagged
 * while the page shows it empty, i.e. the detector would disagree with the
 * surface it sends you to.
 */
export const findEmptyCookedMeals = async (
  db: Database,
): Promise<EmptyCookedMeal[]> => {
  const rows = await getDb(db)
    .select({
      shortcode: meal.shortcode,
      name: meal.name,
      date: meal.date,
    })
    .from(meal)
    .where(
      and(
        notDeleted(meal),
        eq(meal.mealKind, "cooked"),
        notExists(
          getDb(db)
            .select({ one: mealRecipe.id })
            .from(mealRecipe)
            .innerJoin(recipe, eq(recipe.id, mealRecipe.recipeId))
            .where(
              and(
                eq(mealRecipe.mealId, meal.id),
                notDeleted(mealRecipe),
                notDeleted(recipe),
              ),
            ),
        ),
      ),
    )
    // Soonest first: an empty meal three days out is the one worth fixing.
    .orderBy(asc(meal.date));

  return rows.map((row) => ({
    id: unsafeMealShortcode(row.shortcode),
    name: row.name,
    date: row.date,
  }));
};
