/**
 * The order recipe lines are listed in: by recipe name, then section. The server words the
 * `recipeUsageItems` rows in this order and the browser's drift badges re-derive it to line up.
 * A leaf module (no imports) so the request path can sort without loading the recipe schemas.
 */
export const compareRecipeUsages = (
  a: { recipe: { name: string }; sectionName?: string | null },
  b: { recipe: { name: string }; sectionName?: string | null },
) =>
  a.recipe.name.localeCompare(b.recipe.name) ||
  (a.sectionName ?? "").localeCompare(b.sectionName ?? "");
