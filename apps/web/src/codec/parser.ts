import { wasm } from "~/lib/wasm";
import type { CompactRecipe, ParsedCompactRecipe } from "./codec";

export const parseCompactRecipe = (raw: CompactRecipe): ParsedCompactRecipe => {
  return {
    name: raw.name,
    meta: raw.meta,
    sections: raw.sections.map((section) => ({
      ingredients: section.ingredients.map((ingredient) => {
        const parsed = wasm.parse_ingredient(ingredient);
        return {
          name: parsed.name,
          amounts: parsed.amounts,
        };
      }),
      instructions: section.instructions,
    })),
  };
};
