import { wasmServer } from "~/lib/wasm";
import type { CompactRecipe, ParsedCompactRecipe } from "./codec";

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
            const parsed = await wasmServer.parse_ingredient(ingredient);
            return {
              name: parsed.name,
              amounts: parsed.amounts,
            };
          }),
        ),
        instructions: section.instructions,
      })),
    ),
  };
};
