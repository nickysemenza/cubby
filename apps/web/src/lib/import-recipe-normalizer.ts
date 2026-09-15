import type { WIngredient } from "@cubby/recipebridge";
import { amount, sanitizeSectionName } from "@cubby/schemas/codec";
import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { z } from "zod";

import { wasm } from "~/lib/wasm";

type NormalizedImportSection = {
  name: string | null;
  ingredients: string[];
  parsedIngredients?: WIngredient[];
  instructions: { instruction: string }[];
};

type NormalizedImportRecipe = {
  name: string;
  meta: RecipeCreateInput["meta"];
  yield: NonNullable<RecipeCreateInput["yield"]> | null;
  servings: NonNullable<RecipeCreateInput["servings"]> | null;
  tags: string[] | null;
  notes: string | null;
  sections: NormalizedImportSection[];
};

type NormalizedImportYield = Pick<
  NormalizedImportRecipe,
  "yield" | "servings"
> & { servingsFromYield: NormalizedImportRecipe["servings"] };

export const importRecipeUrl = (url: string | undefined): string | null =>
  /^https?:\/\//i.test(url ?? "") ? (url ?? null) : null;

/**
 * The importers' snake_cased `meta` (a verbatim mirror of the Rust
 * `recipe_types::RecipeMeta` JSON) → the persisted camelCased `meta`. Prose
 * strings and minute counts are carried independently on purpose: the extractors
 * fill a string without a count whenever the printed time is a range or an
 * open-ended phrase, and dropping the string in that case would lose the only
 * thing the source actually said.
 */
const normalizeImportMeta = (
  recipe: ImportRecipe,
): RecipeCreateInput["meta"] => {
  const equipment = recipe.meta.equipment?.filter((line) => line.trim() !== "");
  return {
    url: importRecipeUrl(recipe.url),
    times: normalizeImportTimes(recipe.meta.times),
    equipment: equipment && equipment.length > 0 ? equipment : null,
    page: recipe.meta.page ?? null,
  };
};

export const normalizeImportTimes = (
  times: ImportRecipe["meta"]["times"],
): NonNullable<RecipeCreateInput["meta"]>["times"] => ({
  active: times?.active ?? null,
  total: times?.total ?? null,
  prep: times?.prep ?? null,
  cook: times?.cook ?? null,
  activeMinutes: times?.active_minutes ?? null,
  totalMinutes: times?.total_minutes ?? null,
  prepMinutes: times?.prep_minutes ?? null,
  cookMinutes: times?.cook_minutes ?? null,
});

export const normalizeImportYield = (
  recipeYield: ImportRecipe["meta"]["recipe_yield"],
): Omit<NormalizedImportYield, "servings"> => {
  const stringYield = z.string().safeParse(recipeYield);
  if (stringYield.success) {
    const parsed = wasm.parse_yield(stringYield.data);
    return {
      yield: parsed.recipe_yield ?? null,
      servingsFromYield: parsed.servings ?? null,
    };
  }

  return {
    yield: recipeYield === undefined ? null : amount.parse(recipeYield),
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
    meta: normalizeImportMeta(recipe),
    yield: parsedYield.yield,
    servings: recipe.servings ?? parsedYield.servingsFromYield,
    tags: normalizedTags,
    notes: composeNotesMarkdown(recipe.meta.description, recipe.meta.notes),
    sections: recipe.sections.map((section) => ({
      name: sanitizeSectionName(section.name),
      ingredients: section.ingredients,
      parsedIngredients: section.parsedIngredients,
      instructions: section.instructions.map((instruction) => ({
        instruction,
      })),
    })),
  };
};

export const normalizedImportSignatureContent = (
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
