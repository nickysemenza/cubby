import type { ImportRecipe } from "@cubby/schemas/import-recipe";

/** Case/whitespace-insensitive key for matching recipe titles to references. */
export const normalize = (s: string) => s.trim().toLowerCase();

/**
 * First-wins title→index map over a book's recipes. Shared by the cascade-select
 * and the topological import order (both resolve a reference title to its recipe).
 */
const buildTitleIndex = (recipes: ImportRecipe[]): Map<string, number> => {
  const m = new Map<string, number>();
  recipes.forEach((r, i) => {
    const key = normalize(r.meta.title);
    if (!m.has(key)) m.set(key, i);
  });
  return m;
};

/**
 * Add recipe `i` to `selected` along with every in-book recipe it references,
 * transitively, so a recipe's cross-references come along for import and their
 * links can resolve. Mutates `selected`.
 */
export const addWithReferences = (
  recipes: ImportRecipe[],
  selected: Set<number>,
  i: number,
): void => {
  selected.add(i);
  const titleToIndex = buildTitleIndex(recipes);
  const queue = [i];
  for (let cur = queue.pop(); cur != null; cur = queue.pop()) {
    for (const ref of recipes[cur].references) {
      const refIdx = titleToIndex.get(normalize(ref.title));
      if (refIdx != null && !selected.has(refIdx)) {
        selected.add(refIdx);
        queue.push(refIdx);
      }
    }
  }
};

/**
 * Order selected recipes so a referenced recipe imports BEFORE the recipe that
 * references it. Then the reference resolves to a recipe-link on the first insert
 * (no plain-ingredient artifact, no second pass). Edges A→B mean "A references B",
 * so B must come first. Reference cycles can't be fully ordered — leftover nodes
 * are appended in their original order; a cycle back-edge just stays a plain
 * ingredient (used by the recipe, not dangling).
 */
export const topoOrderSelected = (
  recipes: ImportRecipe[],
  selected: number[],
): number[] => {
  const selectedSet = new Set(selected);
  const titleToIndex = buildTitleIndex(recipes);
  const deps = new Map<number, Set<number>>();
  for (const i of selected) {
    const d = new Set<number>();
    for (const ref of recipes[i].references) {
      const refIdx = titleToIndex.get(normalize(ref.title));
      if (refIdx != null && refIdx !== i && selectedSet.has(refIdx)) {
        d.add(refIdx);
      }
    }
    deps.set(i, d);
  }

  const ordered: number[] = [];
  const placed = new Set<number>();
  let progress = true;
  while (ordered.length < selected.length && progress) {
    progress = false;
    for (const i of selected) {
      if (placed.has(i)) continue;
      const ready = [...(deps.get(i) ?? [])].every((dep) => placed.has(dep));
      if (ready) {
        ordered.push(i);
        placed.add(i);
        progress = true;
      }
    }
  }
  // Cycle remainder: append whatever couldn't be ordered, in original order.
  if (ordered.length < selected.length) {
    for (const i of selected) if (!placed.has(i)) ordered.push(i);
  }
  return ordered;
};
