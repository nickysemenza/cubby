import { sanitizeSectionName } from "@cubby/schemas/codec";
import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { wasm } from "~/lib/wasm";

type NormalizedImportSection = {
  name: string | null;
  ingredients: string[];
  instructions: { instruction: string }[];
};

export type NormalizedImportRecipe = {
  name: string;
  meta: RecipeCreateInput["meta"];
  yield: NonNullable<RecipeCreateInput["yield"]> | null;
  servings: NonNullable<RecipeCreateInput["servings"]> | null;
  tags: string[] | null;
  notes: string | null;
  sections: NormalizedImportSection[];
};

export const importRecipeUrl = (url: string | undefined): string | null =>
  /^https?:\/\//i.test(url ?? "") ? (url ?? null) : null;

export const normalizeImportYield = (
  recipeYield: ImportRecipe["meta"]["recipe_yield"],
): {
  yield: NormalizedImportRecipe["yield"];
  servingsFromYield: NormalizedImportRecipe["servings"];
} => {
  if (typeof recipeYield === "string") {
    const parsed = wasm.parse_yield(recipeYield);
    return {
      yield: parsed.recipe_yield ?? null,
      servingsFromYield: parsed.servings ?? null,
    };
  }

  return {
    yield: recipeYield ?? null,
    servingsFromYield: null,
  };
};

export const normalizeImportRecipe = (
  recipe: ImportRecipe,
  tags?: string[] | null,
): NormalizedImportRecipe => {
  const parsedYield = normalizeImportYield(recipe.meta.recipe_yield);
  const normalizedTags = tags && tags.length > 0 ? tags : null;

  return {
    name: recipe.meta.title,
    meta: { url: importRecipeUrl(recipe.url) },
    yield: parsedYield.yield,
    servings: recipe.servings ?? parsedYield.servingsFromYield,
    tags: normalizedTags,
    notes: composeNotesMarkdown(recipe.meta.description, recipe.meta.notes),
    sections: recipe.sections.map((section) => ({
      name: sanitizeSectionName(section.name),
      ingredients: section.ingredients,
      instructions: section.instructions.map((instruction) => ({
        instruction,
      })),
    })),
  };
};

export const normalizedImportSignatureShape = (
  recipe: ImportRecipe,
  tags?: string[] | null,
) => {
  const normalized = normalizeImportRecipe(recipe, tags);
  return {
    yield: normalized.yield,
    servings: normalized.servings,
    tags: [...(normalized.tags ?? [])].sort(),
    notes: normalized.notes,
    sections: normalized.sections.map((section) => ({
      name: section.name,
      ingredients: section.ingredients,
      instructions: section.instructions.map((i) => i.instruction),
    })),
  };
};
