/**
 * Near-duplicate ingredient grouping for the usage table's "merge?" affordance.
 *
 * Name canonicalization now lives in the recipebridge WASM crate
 * (`normalize_ingredient_name`) so the parser and the app agree on what "the
 * same ingredient" is; this module owns only the grouping, with the normalizer
 * injected. That keeps the grouping pure + unit-testable in the node project
 * (no WASM in the test) while the normalization itself is covered by Rust tests.
 *
 * Conservative on purpose: groups only ingredients whose normalized name is
 * exactly equal (not fuzzy), so it catches `butter` / `"Butter for the pan"`
 * without falsely merging `white sugar` / `powdered sugar`. The user confirms
 * every merge, so a missed group is cheaper than a wrong one.
 */

type MergeGroup<T> = { normalized: string; members: T[] };

/**
 * Group rows by normalized name; returns only groups with ≥2 members (the merge
 * candidates), each preserving the input order of its members. `normalize` is
 * injected (production passes `wasm.normalize_ingredient_name`).
 */
export const detectMergeGroups = <T extends { name: string }>(
  rows: readonly T[],
  normalize: (name: string) => string,
): MergeGroup<T>[] => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = normalize(row.name);
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
