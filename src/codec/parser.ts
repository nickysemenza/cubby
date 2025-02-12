import { type CompactRecipe, type ParsedCompactRecipe } from "./codec";
import { getIngredientUnit } from "~/app/_components/recipe/utils";

export const parseCompactRecipe = async (
  raw: CompactRecipe,
): Promise<ParsedCompactRecipe> => {
  return {
    name: raw.name,
    meta: raw.meta,
    sections: await Promise.all(
      raw.sections.map(async (section) => ({
        ingredients: await Promise.all(
          section.ingredients.map(async (ingredient) => {
            const { parse_ingredient } = await import("recipebridge/pkg");
            const parsed = parse_ingredient(ingredient);
            return {
              name: parsed.name,
              amounts: parsed.amounts.map((amount) => ({
                value: amount.value,
                unit: getIngredientUnit(amount),
              })),
            };
          }),
        ),
        instructions: section.instructions,
      })),
    ),
  };
};
