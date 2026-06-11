import type { CompactRecipe, ParsedCompactRecipe } from "@cubby/schemas/codec";
import { wasm } from "~/lib/wasm";

export const parseCompactRecipe = (raw: CompactRecipe): ParsedCompactRecipe => {
  return {
    name: raw.name,
    meta: raw.meta,
    sections: raw.sections.map((section) => ({
      name: section.name,
      ingredients: section.ingredients.map((ingredient) => {
        const parsed = wasm.parse_ingredient(ingredient);
        return {
          name: parsed.name,
          // Copy out of the readonly cached result into the mutable codec shape.
          amounts: parsed.amounts.map((a) => ({ ...a })),
          modifier: parsed.modifier,
          rawLine: ingredient,
        };
      }),
      instructions: section.instructions,
    })),
    recipe_yield: raw.recipe_yield,
    servings: raw.servings,
    description: raw.description,
  };
};
