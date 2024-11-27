import { parse_ingredient } from "recipebridge/pkg/recipebridge";
import { type CompactRecipe, type ParsedCompactRecipe } from "./codec";
import { getIngredientUnit } from "~/app/_components/recipe/utils";

export const parseCompactRecipe = (raw: CompactRecipe): ParsedCompactRecipe => {
  return {
    name: raw.name,
    sections: raw.sections.map((section) => ({
      ingredients: section.ingredients.map((ingredient) => {
        const parsed = parse_ingredient(ingredient);
        return {
          name: parsed.name,
          amounts: parsed.amounts.map((amount) => ({
            value: amount.value,
            unit: getIngredientUnit(amount),
          })),
        };
      }),
      instructions: section.instructions,
    })),
  };
};
