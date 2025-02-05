import { type WMeasure } from "recipebridge/pkg/recipebridge";
import { type RecipeOut, type SectionIngredient } from "~/schemas/recipes";

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

export const getIngredientUnit = (amount: WMeasure): string => {
  // if typeof is OtherUnit
  if (typeof amount.unit === "object" && "Other" in amount.unit) {
    return amount.unit.Other;
  }
  return amount.unit;
};
