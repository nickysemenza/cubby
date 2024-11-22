import {
  type SectionIngredient,
  type RecipeOut,
} from "~/server/api/routers/recipe";

// returns the 1-indexed count of the instruction, across all sections.
export const getGlobalInstructionNumber = (
  recipe: RecipeOut,
  sectionIndex: number,
  instructionIndex: number,
) =>
  recipe.sections
    .slice(0, sectionIndex)
    .map((x) => x.instructions.length)
    .reduce((a, b) => a + b, 0) +
  instructionIndex +
  1;

export const getIngredientName = (ingredient: SectionIngredient) => {
  return ingredient.ingredient?.name ?? ingredient.recipe?.name ?? "unknown";
};
