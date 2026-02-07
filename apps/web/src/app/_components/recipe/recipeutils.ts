import type { RecipeOut, SectionIngredient } from "@cubby/schemas/recipe";
import { assertNever } from "~/lib/assert";

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
  const { type } = ingredient;
  switch (type) {
    case "ingredient":
      return ingredient.ingredient.name;
    case "recipe":
      return ingredient.recipe.name;
    default:
      return assertNever(type);
  }
};
