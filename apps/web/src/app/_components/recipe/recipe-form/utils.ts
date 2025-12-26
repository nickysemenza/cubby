import { type IngItem } from "./types";

/**
 * Normalize an ingredient for comparison by extracting the comparable properties.
 * Used to detect changes between original and updated recipe ingredients.
 */
const normalizeIngredientForComparison = (ing: IngItem) => ({
  id: ing.id,
  type: ing.type,
  ingredientId:
    ing.type === "ingredient" && ing.ingredient ? ing.ingredient.id : null,
  recipeId: ing.type === "recipe" && ing.recipe ? ing.recipe.id : null,
  amounts: ing.amounts,
});

/**
 * Compare two arrays of ingredients to detect if they have changed.
 * Uses JSON.stringify for deep comparison after normalization.
 */
export const haveIngredientsChanged = (
  original: IngItem[],
  updated: IngItem[],
): boolean => {
  return (
    JSON.stringify(original.map(normalizeIngredientForComparison)) !==
    JSON.stringify(updated.map(normalizeIngredientForComparison))
  );
};

/**
 * Compare two arrays of instructions to detect if they have changed.
 * Uses JSON.stringify for deep comparison.
 */
export const haveInstructionsChanged = (
  original: Array<{ id?: string; instruction: string }>,
  updated: Array<{ id?: string; instruction: string }>,
): boolean => {
  return JSON.stringify(original) !== JSON.stringify(updated);
};
