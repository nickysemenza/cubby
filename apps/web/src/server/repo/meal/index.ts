/**
 * Meal repository — public API barrel.
 *
 * A Meal is a planned eating occasion on a calendar day that groups MealRecipe
 * rows (a recipe at a `scale` multiplier). Planning only: no inventory is
 * mutated, and totals are rolled up read-time as `sum(recipe.totals × scale)` —
 * never persisted on the meal. See {@link file://../../../../../docs/terminology.md}.
 * Import meal operations from `~/server/repo/meal` (this barrel).
 *
 *   CRUD → `crud.ts`  (meal create / update / delete + the calendar range read,
 *                      plus add/update/remove of recipes within a meal)
 *
 * Sibling relationships: reads `recipe.totals` (via the recipe repo) to compute
 * scaled rollups; consumed by the meal-planning routers. The shaping/rollup
 * helpers in `helpers.ts` are internal — see the note below.
 */

export {
  addRecipeToMeal,
  createMeal,
  createMealWithEntityId,
  deleteMeals,
  getMealByID,
  getMealsByDateRange,
  getUpcomingMealSummary,
  mealList,
  removeMealRecipeWithEntityId,
  updateMeal,
  updateMealRecipeWithEntityId,
} from "./crud";
// Helpers (dbMealToAPI, rollupMealTotals, scaleTotals) are intentionally not
// re-exported here — they're used internally within ./helpers and ./crud.
