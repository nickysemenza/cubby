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

/**
 * Format a recipe yield for display, e.g. "18 servings".
 *
 * CHARACTERIZATION / KNOWN DEBT: this currently renders the raw unit, so a
 * unitless yield shows the parser's "whole" sentinel ("18 whole"). That's
 * intentional for now and pinned by recipe-utils.unit.test.ts. The fix is to
 * drop the unit when it equals "whole" (and flip that test), alongside the
 * deferred ingredient-parser work. See the plan.
 */
export const formatYield = (y: { value: number; unit: string }): string =>
  `${y.value} ${y.unit}`;

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
