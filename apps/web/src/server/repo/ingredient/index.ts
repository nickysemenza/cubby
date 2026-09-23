/**
 * Ingredient repository — public API barrel.
 *
 * An Ingredient is a standalone, costable concept (or a sub-recipe pointer when
 * `recipeId` is set); it carries case-insensitive name + aliases, links to zero
 * or more Products, and is referenced by recipe lines. Import ingredient
 * operations from `~/server/repo/ingredient` (this barrel) rather than the
 * individual modules.
 *
 *   CRUD     → `crud.ts`      (create / update / get-by-id, find-or-create,
 *                              batch resolve-or-create)
 *   SEARCH   → `search.ts`    (merge-suggester search, name/alias matching,
 *                              paginated list, lean by-id + workbench reads,
 *                              recipe-usage lookup)
 *   MERGE    → `merge.ts`     (trigram near-dup candidates + the merge op)
 *   DELETION → `deletion.ts`  (soft delete with recipe/product guards)
 *
 * Internal-only shaping (`internal-types.ts`: the deep DB row, product/usage
 * transforms, and the name-match `where` builder) is not re-exported.
 */

export {
  createIngredient,
  findOrCreateIngredient,
  getIngredientByID,
  resolveOrCreateIngredients,
  updateIngredient,
  updateIngredientsUsuallyOnHand,
} from "./crud";
export { deleteIngredients } from "./deletion";
export { findFuzzyMergeCandidates, mergeIngredients } from "./merge";
export {
  enrichmentWorkbenchIngredients,
  getIngredientByName,
  getIngredientMatches,
  getIngredientMergeCandidatesByIds,
  getIngredientsByIDsLean,
  getRecipeUsagesForIngredient,
  ingredientList,
  searchIngredientsForMerge,
} from "./search";
