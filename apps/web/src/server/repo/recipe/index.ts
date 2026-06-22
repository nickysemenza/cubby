/**
 * Recipe repository module.
 *
 * Re-exports all recipe-related repository functions.
 * Import from this file for all recipe operations.
 */

// ImportRecipe → RecipeCreateInput conversion + upserts
export {
  upsertCookbookRecipeFromCookbook,
  upsertImportRecipe,
  upsertNotionRecipeFromImport,
} from "../import-recipe-convert";
// CRUD operations
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
  recipeList,
  updateRecipe,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./crud";
// Helpers
export {
  computeRecipeUsages,
  dbRecipeToAPIShallow,
  liveRecipeCountForIngredientSql,
} from "./helpers";
// Analytics and queries
export {
  getAllTags,
  getIngredientCooccurrence,
  getIngredientUsage,
  getRecipeDependencyGraph,
} from "./queries";
export { findOrCreateRecipeLinkIngredient } from "./update-helpers";
