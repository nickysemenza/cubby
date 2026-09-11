import type {
  CookbookEdge,
  CookbookExtraction,
  CookbookRecipe,
} from "@cubby/schemas/cookbook";

/** A recipe item with the chapter it sits in. */
export type FlatRecipe = {
  recipe: CookbookRecipe;
  chapter: string | null;
};

/** Every recipe item in reading order, with its chapter title. */
export const flattenRecipes = (extraction: CookbookExtraction): FlatRecipe[] =>
  extraction.chapters.flatMap((chapter) =>
    chapter.items.flatMap((item) =>
      item.kind === "recipe"
        ? [{ recipe: item, chapter: chapter.title ?? null }]
        : [],
    ),
  );

/**
 * The dependency edges: `from` uses `to` as an ingredient or is a variation
 * of it. Step and note mentions are cross-references, not dependencies.
 */
export const dependencyEdges = (
  extraction: CookbookExtraction,
): CookbookEdge[] =>
  extraction.edges.filter(
    (edge) => edge.kind === "ingredient" || edge.kind === "variation",
  );

/** `id → ids it depends on`, restricted to recipes in the tree. */
const dependencyMap = (
  extraction: CookbookExtraction,
): Map<string, Set<string>> => {
  const recipeIds = new Set(flattenRecipes(extraction).map((f) => f.recipe.id));
  const deps = new Map<string, Set<string>>();
  for (const edge of dependencyEdges(extraction)) {
    if (!recipeIds.has(edge.from) || !recipeIds.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    let set = deps.get(edge.from);
    if (!set) {
      set = new Set();
      deps.set(edge.from, set);
    }
    set.add(edge.to);
  }
  return deps;
};

/**
 * Add `id` to `selected` along with every recipe it depends on,
 * transitively, so its sub-recipe lines can link on import. Mutates
 * `selected`.
 */
export const addWithDependencies = (
  extraction: CookbookExtraction,
  selected: Set<string>,
  id: string,
): void => {
  const deps = dependencyMap(extraction);
  const queue = [id];
  selected.add(id);
  for (let cur = queue.pop(); cur !== undefined; cur = queue.pop()) {
    for (const dep of deps.get(cur) ?? []) {
      if (!selected.has(dep)) {
        selected.add(dep);
        queue.push(dep);
      }
    }
  }
};

/**
 * Order the selected recipe ids so a dependency imports BEFORE the recipe
 * that uses it: the sub-recipe link resolves on the first insert, with no
 * plain-ingredient placeholder and no second pass. A cycle (two recipes each
 * using the other) cannot be ordered; its members append in book order and
 * the back-edge stays a plain ingredient line.
 */
export const topoOrder = (
  extraction: CookbookExtraction,
  selected: readonly string[],
): string[] => {
  const bookOrder = new Map(
    flattenRecipes(extraction).map((f, i) => [f.recipe.id, i] as const),
  );
  const wanted = [...new Set(selected)].sort(
    (a, b) => (bookOrder.get(a) ?? Infinity) - (bookOrder.get(b) ?? Infinity),
  );
  const wantedSet = new Set(wanted);
  const deps = dependencyMap(extraction);
  const ordered: string[] = [];
  const placed = new Set<string>();
  let progress = true;
  while (ordered.length < wanted.length && progress) {
    progress = false;
    for (const id of wanted) {
      if (placed.has(id)) continue;
      const ready = [...(deps.get(id) ?? [])].every(
        (dep) => !wantedSet.has(dep) || placed.has(dep),
      );
      if (ready) {
        ordered.push(id);
        placed.add(id);
        progress = true;
      }
    }
  }
  for (const id of wanted) if (!placed.has(id)) ordered.push(id);
  return ordered;
};
