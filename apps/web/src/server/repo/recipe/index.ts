/**
 * Recipe repository module.
 *
 * Re-exports all recipe-related repository functions.
 * Import from this file for all recipe operations.
 */

// CRUD operations
export {
  type CookbookRef,
  createRecipe,
  deleteRecipes,
  deleteRecipesByCookbook,
  getCookbookRecipeIdsByTitle,
  getCookbookRecipeTitles,
  getRecipeByID,
  getRecipeByShortcode,
  getRecipesByIDs,
  insertCompactRecipe,
  insertCookbookRecipe,
  recipeList,
  updateRecipe,
  upsertCookbookRecipe,
  upsertRecipe,
} from "./crud";
// Helpers
export { dbRecipeToAPIShallow } from "./helpers";
// Analytics and queries
export { getAllTags, getIngredientCooccurrence } from "./queries";
export { findOrCreateRecipeLinkIngredient } from "./update-helpers";
