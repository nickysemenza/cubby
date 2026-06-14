/**
 * Heuristic near-duplicate ingredient detection for the usage table's "merge?"
 * affordance. Pure + alias-free so it can be unit-tested in the node project.
 *
 * Conservative on purpose: groups ingredients whose *normalized* name is
 * exactly equal (not fuzzy), so it catches `butter` / `"Butter for the pan"`
 * without falsely merging `white sugar` / `powdered sugar`. The user always
 * confirms the merge, so a missed group is cheaper than a wrong one.
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

export const normalizeIngredientName = (name: string): string => {
  let s = name.toLowerCase().trim();
  // Drop parentheticals, e.g. "sugar (for dusting)".
  s = s.replace(/\([^)]*\)/g, " ");
  // Drop a trailing prep note after a comma, e.g. "butter, softened".
  s = s.replace(/,\s.*$/, " ");
  for (const phrase of SUFFIX_PHRASES) {
    s = s.replace(new RegExp(`\\b${phrase}\\b`, "g"), " ");
  }
  // Collapse whitespace + stray separators.
  s = s.replace(/[\s,;]+/g, " ").trim();
  return s;
};

export type MergeGroup<T> = { normalized: string; members: T[] };

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
