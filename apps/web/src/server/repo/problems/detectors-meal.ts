/**
 * Meal-centric Problems detectors.
 *
 * Only the understated-cost rollup lives here now. "Cooked meal with no
 * recipes" became the `meal/empty-cooked` saved view — `mealKind` plus the
 * `meal.recipes` related-view presence filter, whose SQL already carries the
 * same two soft-delete guards this file spells out below.
 *
 * That section exists at all because `mealKind` made it expressible. Before it,
 * a meal with no recipes was ambiguous — an unfinished plan and a deliberate
 * eating-out placeholder were the same row — so "empty meal" could not be
 * stated as a defect without also accusing every correct placeholder.
 */

import { unsafeMealShortcode } from "@cubby/schemas/identifiers";
import type { UnderstatedCostMeal } from "@cubby/schemas/problems";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { meal, mealRecipe, recipe } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Planned meals whose cost rollup is knowingly incomplete — some live recipe
 * was costed and came back with fewer priced ingredients than it has.
 *
 * The predicate is `costCovered < ingredientCount` inside `recipe.totals`, NOT
 * `totals IS NULL`. A null `totals` only means the costing queue hasn't reached
 * that recipe; it clears itself on the next drain and `staleRecipeTotals`
 * already owns it. This set stays put until an ingredient gains a price path,
 * which is what makes it worth a row on the Problems page.
 *
 * Same two soft-delete guards as above: the link and the recipe both have to be
 * live, or a meal is judged on a recipe it no longer shows.
 */
export const findUnderstatedCostMeals = async (
  db: Database,
): Promise<UnderstatedCostMeal[]> => {
  const rows = await getDb(db)
    .select({
      shortcode: meal.shortcode,
      name: meal.name,
      date: meal.date,
      recipeCount: count(mealRecipe.id),
    })
    .from(meal)
    .innerJoin(
      mealRecipe,
      and(eq(mealRecipe.mealId, meal.id), notDeleted(mealRecipe)),
    )
    .innerJoin(
      recipe,
      and(eq(recipe.id, mealRecipe.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(meal),
        // `->>` yields text; both sides cast so this is a numeric comparison
        // rather than a lexicographic one ("9" > "10" as text).
        sql`(${recipe.totals} ->> 'costCovered')::int < (${recipe.totals} ->> 'ingredientCount')::int`,
      ),
    )
    .groupBy(meal.id, meal.shortcode, meal.name, meal.date)
    .orderBy(asc(meal.date));

  return rows.map((row) => ({
    id: unsafeMealShortcode(row.shortcode),
    name: row.name,
    date: row.date,
    recipeCount: row.recipeCount,
  }));
};
