import { type IngItem, type RecipeFormValues } from "./types";

/**
 * Normalize an ingredient for comparison by extracting the comparable properties.
 * Used to detect changes between original and updated recipe ingredients.
 */
export const normalizeIngredientForComparison = (ing: IngItem) => ({
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

type FormSection = RecipeFormValues["sections"][number];

interface OriginalSection {
  id: string;
  name: string | null;
  ingredients: IngItem[];
  instructions: Array<{ id: string; instruction: string }>;
}

/**
 * Detect what has changed in a recipe section compared to its original.
 * Returns an object containing only the changed fields (plus id for existing sections).
 */
export const detectSectionChanges = (
  section: FormSection,
  originalSection: OriginalSection | undefined,
) => {
  // For a new section or completely changed section
  if (!originalSection || !section.id) {
    return {
      isNew: true as const,
      name: section.name,
      ingredients: section.ingredients,
      instructions: section.instructions,
    };
  }

  // For existing section, track what has changed
  const changes: {
    isNew: false;
    id: string;
    nameChanged: boolean;
    name?: string | null;
    ingredientsChanged: boolean;
    ingredients?: IngItem[];
    instructionsChanged: boolean;
    instructions?: Array<{ id?: string; instruction: string }>;
  } = {
    isNew: false,
    id: section.id,
    nameChanged: originalSection.name !== section.name,
    ingredientsChanged: haveIngredientsChanged(
      originalSection.ingredients,
      section.ingredients,
    ),
    instructionsChanged: haveInstructionsChanged(
      originalSection.instructions,
      section.instructions,
    ),
  };

  if (changes.nameChanged) {
    changes.name = section.name;
  }

  if (changes.ingredientsChanged) {
    changes.ingredients = section.ingredients;
  }

  if (changes.instructionsChanged) {
    changes.instructions = section.instructions;
  }

  return changes;
};
