/**
 * Heuristic near-duplicate ingredient detection for the usage table's "merge?"
 * affordance. Pure + alias-free so it can be unit-tested in the node project.
 *
 * Conservative on purpose: groups ingredients whose *normalized* name is
 * exactly equal (not fuzzy), so it catches `butter` / `"Butter for the pan"`
 * without falsely merging `white sugar` / `powdered sugar`. The user always
 * confirms the merge, so a missed group is cheaper than a wrong one.
 *
 * TODO: name normalization/canonicalization really belongs in the shared
 * ingredient-parser crate (it already parses ingredient lines) so the web app
 * and the parser agree on what "the same ingredient" means. This TS heuristic
 * is a stopgap until recipebridge exposes a `normalize_ingredient_name` (or
 * similar) over WASM; move this there and have detectMergeGroups call it.
 */

// Trailing usage notes that don't change the underlying ingredient.
const SUFFIX_PHRASES = [
  "for the pan",
  "for the topping",
  "for dusting",
  "for greasing",
  "for brushing",
  "for sprinkling",
  "for rolling",
  "for garnish",
  "for serving",
  "for frying",
  "to taste",
  "as needed",
];

// Precompile once at module load — normalize runs for every ingredient row on
// each render, so rebuilding these per-phrase per-call is wasteful.
const SUFFIX_REGEXES = SUFFIX_PHRASES.map(
  (phrase) => new RegExp(`\\b${phrase}\\b`, "g"),
);

export const normalizeIngredientName = (name: string): string => {
  let s = name.toLowerCase().trim();
  // Drop parentheticals, e.g. "sugar (for dusting)".
  s = s.replace(/\([^)]*\)/g, " ");
  // Drop a trailing prep note after a comma, e.g. "butter, softened".
  s = s.replace(/,\s.*$/, " ");
  for (const re of SUFFIX_REGEXES) {
    s = s.replace(re, " ");
  }
  // Collapse whitespace + stray separators.
  s = s.replace(/[\s,;]+/g, " ").trim();
  return s;
};

type MergeGroup<T> = { normalized: string; members: T[] };

/**
 * Group rows by normalized name; returns only groups with ≥2 members (the merge
 * candidates), each preserving the input order of its members.
 */
export const detectMergeGroups = <T extends { name: string }>(
  rows: readonly T[],
): MergeGroup<T>[] => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = normalizeIngredientName(row.name);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([normalized, members]) => ({ normalized, members }));
};
