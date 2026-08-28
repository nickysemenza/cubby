/**
 * Stable content signatures for recipes, so an import preview can tell
 * "already imported, no changes" from "will update". Every builder constructs
 * the same normalized object with identical key order (JSON.stringify is then
 * order-stable) from the same fields. The import paths persist each ingredient's
 * raw source line as `rawLine`, so comparing raw lines is a faithful "did the
 * source change" check — independent of ingredient resolution / linking.
 */

import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { RecipeGraphOut, RecipeOut } from "@cubby/schemas/recipe";

import { normalizedImportSignatureShape } from "~/lib/import-recipe-normalizer";

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
export function recipeOutSignature(recipe: RecipeOut | RecipeGraphOut): string {
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

/**
 * Signature of the recipe an `ImportRecipe` (scraper / EPUB / Notion) *would*
 * import as — applies the same transforms as `importRecipeToRecipeInput` (yield
 * union → WASM parse or use-as-is, servings fallback, composed notes, sanitized
 * section names) so it matches the stored recipe's `recipeOutSignature`. `tags`
 * is supplied by the Notion column path; the EPUB path carries none.
 */
export function importRecipeSignature(
  cr: ImportRecipe,
  tags: string[] = [],
): string {
  return signature(normalizedImportSignatureShape(cr, tags));
}
