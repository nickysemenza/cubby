import type { Amount } from "@cubby/schemas/codec";
import type { RecipeOut } from "@cubby/schemas/recipe";
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
  amounts: Amount[];
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
  amounts: Amount[];
  modifier?: string | null;
}): string =>
  [
    "Ingredient parse from cubby (raw line + how it parsed):",
    "",
    buildParseBlock(args),
  ].join("\n");

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
  // don't emit a dangling header. Keep original indices for "Section N" labels.
  const nonEmpty = recipe.sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.ingredients.length > 0);

  // Only suppress the section header for the degenerate single-unnamed-section
  // case; otherwise label each section (named or "Section N") for grouping.
  const showSectionHeaders =
    nonEmpty.length > 1 || Boolean(nonEmpty[0]?.section.name);

  const sectionBlocks = nonEmpty.map(({ section, index }) => {
    const body = section.ingredients
      .map((ingredient) =>
        buildParseBlock({
          rawLine: ingredient.rawLine ?? "(none)",
          name: getIngredientName(ingredient),
          amounts: ingredient.amounts,
          modifier: ingredient.modifier,
        }),
      )
      .join("\n\n");
    return showSectionHeaders
      ? `[${section.name ?? `Section ${index + 1}`}]\n${body}`
      : body;
  });

  // Blank line between the header, each section, and between ingredient blocks.
  return [header, ...sectionBlocks].join("\n\n");
};
