/**
 * Stable content signatures for recipes, so an import preview can tell
 * "already imported, no changes" from "will update". Every builder constructs
 * the same normalized object with identical key order (JSON.stringify is then
 * order-stable) from the same fields. The import paths persist each ingredient's
 * raw source line as `rawLine`, so comparing raw lines is a faithful "did the
 * source change" check — independent of ingredient resolution / linking.
 */

import { sanitizeSectionName } from "@cubby/schemas/codec";
import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { RecipeGraphOut, RecipeOut } from "@cubby/schemas/recipe";

import {
  normalizedImportSignatureContent,
  normalizeImportYield,
} from "~/lib/import-recipe-normalizer";

type RecipeSignatureContent = {
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

const signature = (content: RecipeSignatureContent): string =>
  JSON.stringify(content);

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
  return signature(normalizedImportSignatureContent(cr, tags));
}

/**
 * Signature of the recipe a cookbook tree item *would* import as.
 *
 * A cookbook recipe never travels through `ImportRecipe` any more — the crate
 * hands the server the book tree and `cookbookRecipeToRecipeInput` (see
 * `~/server/repo/import-recipe-convert.ts`) persists it directly — so this
 * mirrors that converter field for field rather than reusing the import-recipe
 * path. Getting it wrong shows up as a recipe stuck on "will update" forever,
 * so the correspondences worth naming are:
 *
 * - the chapter title is the recipe's only tag (`tags: chapter ? [chapter] : null`);
 * - notes are the headnote paragraphs followed by the labelled notes, exactly as
 *   `cookbookRecipeNotes` composes them;
 * - an ingredient persists its `raw` source line as `rawLine`, which is what
 *   `recipeOutSignature` reads back — the crate's parse is deliberately not part
 *   of the signature, since re-parsing the same line is not a source change;
 * - `meta` (url, times, equipment, page) is stored but not signed, matching
 *   `recipeOutSignature`.
 */
export function cookbookRecipeSignature(
  item: CookbookRecipe,
  chapter?: string | null,
): string {
  const parsedYield = normalizeImportYield(item.meta.recipe_yield ?? undefined);
  return signature({
    yield: parsedYield.yield,
    servings: parsedYield.servingsFromYield,
    tags: chapter ? [chapter] : [],
    notes: composeNotesMarkdown(
      item.meta.description.join("\n\n"),
      item.notes.map((note) =>
        note.label ? `**${note.label}** ${note.text}` : note.text,
      ),
    ),
    sections: item.sections.map((section) => ({
      name: sanitizeSectionName(section.name),
      ingredients: section.ingredients.map((line) => line.raw),
      instructions: section.steps.map((step) => step.text),
    })),
  });
}
