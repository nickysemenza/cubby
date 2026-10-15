import type {
  CookbookIngredientLine,
  CookbookRecipe,
} from "@cubby/schemas/cookbook";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";

import type { ParsedLineRow, SubRecipeLink } from "../parsed-ingredient-table";

const cardTimes = (
  times: CookbookRecipe["meta"]["times"],
): ImportRecipe["meta"]["times"] => {
  if (!times) return undefined;
  return {
    active: times.active ?? undefined,
    total: times.total ?? undefined,
    prep: times.prep ?? undefined,
    cook: times.cook ?? undefined,
    active_minutes: times.active_minutes ?? undefined,
    total_minutes: times.total_minutes ?? undefined,
    prep_minutes: times.prep_minutes ?? undefined,
    cook_minutes: times.cook_minutes ?? undefined,
  };
};

/**
 * A cookbook tree item, in the shape `RecipeImportCard` renders.
 *
 * The card is shared with the Notion / scrape importer, which still speaks
 * `ImportRecipe`, so this adapter exists rather than a second card. It is a
 * *view*, not a conversion: nothing here reaches the server. The server is
 * handed the tree itself (`upsertCookbook` stores it, `importCookbookStream`
 * reads it back), so this mapping cannot corrupt the imported data — at worst
 * it mislabels the preview.
 *
 * `meta.title` carries the item's `name`, not its `title`: `name` is the
 * disambiguated form the import persists and the diff keys on, so showing it is
 * what makes "imported · no changes" legible in a book that prints the same
 * title twice.
 */
export const toRecipeCardView = (item: CookbookRecipe): ImportRecipe => ({
  meta: {
    title: item.name,
    description: item.meta.description.join("\n\n"),
    recipe_yield: item.meta.recipe_yield ?? undefined,
    times: cardTimes(item.meta.times),
    equipment: item.meta.equipment,
    notes: item.notes.map((note) =>
      note.label ? `**${note.label}** ${note.text}` : note.text,
    ),
    category: item.meta.category ?? undefined,
    page: item.meta.page ?? undefined,
  },
  sections: item.sections.map((section) => ({
    name: section.name ?? undefined,
    ingredients: section.ingredients.map((line) => line.raw),
    instructions: section.steps.map((step) => step.text),
  })),
});

/**
 * The crate's parse of each ingredient line, per section, ready for
 * `ParsedIngredientTable`.
 *
 * Passing these down rather than letting the card re-parse is the point: the
 * crate's reading is the one `cookbookRecipeToRecipeInput` persists, so a
 * second parse in the browser could show amounts and names the import never
 * stores.
 */
export const parsedLinesFor = (
  item: CookbookRecipe,
  linkFor: (line: CookbookIngredientLine) => SubRecipeLink | undefined,
): ParsedLineRow[][] =>
  item.sections.map((section) =>
    section.ingredients.map((line) => ({
      raw: line.raw,
      parsed: {
        name: line.parsed.name,
        amounts: line.parsed.amounts.map((amount) => ({
          unit: amount.unit,
          value: amount.value,
          upper_value: amount.upper_value ?? undefined,
        })),
        modifier: line.parsed.modifier ?? null,
      },
      link: linkFor(line),
    })),
  );
