/**
 * Recipe repository — public API barrel.
 *
 * Import recipe operations from `~/server/repo/recipe` (this barrel) rather than
 * the individual modules. The barrel is the canonical surface; the per-file split
 * below mirrors how the work is organised:
 *
 *   READ path   → `queries.ts`  (analytics: tags, usage, co-occurrence, dep graph)
 *               + the read/lookup functions in `crud.ts` (getById, list, diff/title lookups)
 *   WRITE path  → `crud.ts`     (create / update / delete / upsert orchestration)
 *               + `update-helpers.ts` (section + ingredient mutation internals)
 *   IMPORT      → `import-recipe-convert.ts` (ImportRecipe → RecipeCreateInput + upserts)
 *   TOTALS      → `totals.ts`   (precomputed cost/calorie persistence + staleness)
 *   SHAPING     → `helpers.ts`  (DB row → API type conversion, usage-count SQL)
 *
 * Internal-only modules (`source.ts` codec, `internal-types.ts`) are intentionally
 * not re-exported — they're consumed within this package only.
 */

// ImportRecipe → RecipeCreateInput conversion + upserts
export {
  type CookbookImportContext,
  upsertCookbookRecipeFromCookbook,
  upsertImportRecipe,
  upsertNotionRecipeFromImport,
} from "../import-recipe-convert";
// CRUD operations (read lookups + write orchestration)
export {
  type CookbookRef,
  createRecipe,
  deleteRecipes,
  deleteRecipesByCookbook,
  getCookbookRecipeIdsByTitle,
  getCookbookRecipesForDiff,
  getCookbookRecipeTitles,
  getNotionRecipePageIds,
  getNotionRecipesForDiff,
  getRecipeByID,
  getRecipeByShortcode,
  getRecipesByIDs,
  normalizeTitle,
  recipeList,
  updateRecipe,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./crud";
// Row → API shaping helpers
export {
  appearsInRecipesRefsForIngredientSql,
  computeRecipeUsages,
  cookbookOnlyForIngredientSql,
  dbRecipeToAPIShallow,
  dbRecipeToTopLevelShape,
  liveRecipeCountForIngredientSql,
} from "./helpers";
// Analytics and queries (read path)
export {
  getAllTags,
  getIngredientCooccurrence,
  getIngredientUsage,
  getRecipeDependencyGraph,
} from "./queries";
// Precomputed totals (cost/calories): import directly via
// `~/server/repo/recipe/totals` (the costing service is the sole consumer; not
// re-exported here to keep the barrel surface to what's used across packages).
// Sub-recipe link helper (write path)
export { findOrCreateRecipeLinkIngredient } from "./update-helpers";
