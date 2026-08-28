import type { Amount } from "@cubby/schemas/codec";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { RecipeOut } from "@cubby/schemas/recipe";

import { wasm } from "~/lib/wasm";

import { formatYield, getIngredientName } from "./recipe-utils";

/**
 * One ingredient's raw import line alongside how cubby parsed it, as a plain
 * paste-ready block to drop into a Claude session on the `ingredient-parser`
 * repo. Deliberately format-agnostic — just the facts (input + parsed output);
 * the parser side knows how to turn it into a corpus row and a fix.
 */
const buildParseBlock = (args: {
  rawLine: string;
  name: string;
  amounts: readonly Amount[];
  modifier?: string | null;
}): string => {
  const amounts = JSON.stringify(
    args.amounts.map((a) => ({ unit: a.unit, value: a.value })),
  );
  return [
    `raw:      ${args.rawLine}`,
    `name:     ${args.name}`,
    `amounts:  ${amounts}`,
    `modifier: ${args.modifier ?? "(none)"}`,
  ].join("\n");
};

/** A single parsed ingredient line, with a one-line header. */
export const buildParseReport = (args: {
  rawLine: string;
  name: string;
  amounts: readonly Amount[];
  modifier?: string | null;
}): string =>
  [
    "Ingredient parse from cubby (raw line + how it parsed):",
    "",
    buildParseBlock(args),
  ].join("\n");

/**
 * Assemble a sectioned parse report: the `header`, then one block per section,
 * each a `name`-less or `[name]`-labelled group of pre-built ingredient blocks.
 * Empty sections are dropped before this is called. The section header is
 * suppressed only for the degenerate single-unnamed-section case; otherwise
 * every section is labelled (named or "Section N") for grouping.
 */
const assembleSectionedReport = (
  header: string,
  sections: { name?: string; blocks: string[] }[],
): string => {
  const showSectionHeaders = sections.length > 1 || Boolean(sections[0]?.name);

  const sectionBlocks = sections.map((section, index) => {
    const body = section.blocks.join("\n\n");
    return showSectionHeaders
      ? `[${section.name ?? `Section ${index + 1}`}]\n${body}`
      : body;
  });

  // Blank line between the header, each section, and between ingredient blocks.
  return [header, ...sectionBlocks].join("\n\n");
};

/**
 * The whole recipe's raw lines + parse, scoped up from {@link buildParseReport}:
 * a header (title/yield/servings) then a `buildParseBlock` per ingredient,
 * grouped by section.
 */
export const buildRecipeParseReport = (recipe: RecipeOut): string => {
  const header = [
    "Recipe parse from cubby (raw lines + how they parsed):",
    "",
    `title:    ${recipe.name}`,
    `yield:    ${recipe.yield ? formatYield(recipe.yield) : "(none)"}`,
    `servings: ${recipe.servings ?? "(none)"}`,
  ].join("\n");

  // Skip ingredient-less sections (e.g. an instructions-only section) so they
  // don't emit a dangling header.
  const sections = recipe.sections
    .filter((section) => section.ingredients.length > 0)
    .map((section) => ({
      name: section.name ?? undefined,
      blocks: section.ingredients.map((ingredient) =>
        buildParseBlock({
          rawLine: ingredient.rawLine ?? "(none)",
          name: getIngredientName(ingredient),
          amounts: ingredient.amounts,
          modifier: ingredient.modifier,
        }),
      ),
    }));

  return assembleSectionedReport(header, sections);
};

/**
 * Like {@link buildRecipeParseReport}, but for the import-time {@link ImportRecipe}
 * shape: ingredient lines are still raw strings, so each is parsed on the fly
 * with the WASM parser (cached). Used by the cookbook-import review UI to copy a
 * recipe's raw lines + how cubby parsed them into an `ingredient-parser` session.
 */
export const buildImportRecipeParseReport = (recipe: ImportRecipe): string => {
  const { recipe_yield } = recipe.meta;
  const yieldLabel =
    recipe_yield == null
      ? "(none)"
      : typeof recipe_yield === "string"
        ? recipe_yield
        : `${recipe_yield.value} ${recipe_yield.unit}`;

  const header = [
    "Recipe parse from cubby (raw lines + how they parsed):",
    "",
    `title:    ${recipe.meta.title}`,
    `yield:    ${yieldLabel}`,
    `servings: ${recipe.servings ?? "(none)"}`,
  ].join("\n");

  const sections = recipe.sections
    .filter((section) => section.ingredients.length > 0)
    .map((section) => {
      // One batch call per section instead of one per line — output order
      // matches input (parse_ingredient_lines contract), so indexing by
      // position below is safe.
      const parsedLines = wasm.parse_ingredient_lines(section.ingredients);
      return {
        name: section.name ?? undefined,
        blocks: section.ingredients.map((line, i) => {
          const parsed = parsedLines[i]!;
          return buildParseBlock({
            rawLine: line,
            name: parsed.name,
            amounts: parsed.amounts,
            modifier: parsed.modifier,
          });
        }),
      };
    });

  return assembleSectionedReport(header, sections);
};
