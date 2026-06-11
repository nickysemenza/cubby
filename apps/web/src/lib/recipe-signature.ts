/**
 * Stable content signatures for recipes, so an import preview can tell
 * "already imported, no changes" from "will update". Every builder constructs
 * the same normalized object with identical key order (JSON.stringify is then
 * order-stable) from the same fields. The import paths persist each ingredient's
 * raw source line as `rawLine`, so comparing raw lines is a faithful "did the
 * source change" check — independent of ingredient resolution / linking.
 */

import type { CompactRecipe } from "@cubby/schemas/codec";
import { sanitizeSectionName } from "@cubby/schemas/codec";
import {
  type CookbookRecipe,
  composeNotesMarkdown,
} from "@cubby/schemas/cookbook";
import type { RecipeOut } from "@cubby/schemas/recipe";
import { wasm } from "~/lib/wasm";

type SignatureShape = {
  yield: { value: number; unit: string } | null;
  servings: number | null;
  tags: string[];
  notes: string | null;
  sections: {
    name: string | null;
    ingredients: string[];
    instructions: string[];
  }[];
};

const signature = (shape: SignatureShape): string => JSON.stringify(shape);

/** Signature of an already-imported recipe, from its stored content. */
export function recipeOutSignature(recipe: RecipeOut): string {
  return signature({
    yield: recipe.yield
      ? { value: recipe.yield.value, unit: recipe.yield.unit }
      : null,
    servings: recipe.servings ?? null,
    tags: [...(recipe.tags ?? [])].sort(),
    notes: recipe.notes ?? null,
    sections: recipe.sections.map((s) => ({
      name: s.name ?? null,
      ingredients: s.ingredients.map((i) => i.rawLine ?? ""),
      instructions: s.instructions.map((i) => i.instruction),
    })),
  });
}

/** Signature of the recipe a Notion page *would* import as. */
export function compactSignature(
  compact: CompactRecipe,
  tags: string[],
): string {
  return signature({
    yield: compact.recipe_yield
      ? { value: compact.recipe_yield.value, unit: compact.recipe_yield.unit }
      : null,
    servings: compact.servings ?? null,
    tags: [...tags].sort(),
    notes: composeNotesMarkdown(compact.description, null),
    sections: compact.sections.map((s) => ({
      name: s.name ?? null,
      ingredients: s.ingredients,
      instructions: s.instructions,
    })),
  });
}

/**
 * Signature of the recipe an EPUB `CookbookRecipe` *would* import as — applies
 * the same transforms as `cookbookRecipeToRecipeInput` (WASM yield parse,
 * composed notes, sanitized section names) so it matches the stored recipe's
 * `recipeOutSignature`. Cookbook recipes carry no tags.
 */
export function cookbookRecipeSignature(cr: CookbookRecipe): string {
  const parsedYield = cr.meta.recipe_yield
    ? wasm.parse_yield(cr.meta.recipe_yield)
    : undefined;
  return signature({
    yield: parsedYield?.recipe_yield
      ? {
          value: parsedYield.recipe_yield.value,
          unit: parsedYield.recipe_yield.unit,
        }
      : null,
    servings: parsedYield?.servings ?? null,
    tags: [],
    notes: composeNotesMarkdown(cr.meta.description, cr.meta.notes),
    sections: cr.sections.map((s) => ({
      name: sanitizeSectionName(s.name),
      ingredients: s.ingredients,
      instructions: s.instructions,
    })),
  });
}
