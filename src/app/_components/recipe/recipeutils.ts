import { type RecipeOut, type SectionIngredient } from "~/schemas/recipe";

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

export const getIngredientName = (ingredient: SectionIngredient): string => {
  // With discriminated union, exhaustively check all possible types
  switch (ingredient.type) {
    case "ingredient":
      return ingredient.ingredient.name;
    case "recipe":
      return ingredient.recipe.name;
  }
  // TypeScript exhaustiveness check - this will catch if we add a new type
  // to the discriminated union but forget to handle it here
  const _exhaustiveCheck: never = ingredient;
  return _exhaustiveCheck; // This line is unreachable but pleases TypeScript
};
