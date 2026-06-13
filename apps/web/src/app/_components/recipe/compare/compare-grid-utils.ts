/**
 * Pure helpers for the parametric recipe-comparison grid. Deliberately free of
 * `~/` value imports and any `.tsx` imports so it runs in the alias-free "unit"
 * vitest project (see compare-grid-utils.unit.test.ts). The grid component does
 * the heavy extraction from a RecipeCosting; this module only aligns the
 * already-extracted per-recipe rows and does the deviation math.
 */

/** Which amount the grid plots: scale-invariant baker's % or absolute grams. */
export type CompareBasis = "baker" | "gram";

/** One ingredient's extracted figures within a single recipe. */
export type RecipeRowEntry = {
  /** Display name (original casing of the first occurrence). */
  label: string;
  isFlour: boolean;
  /** Resolved weight in grams; null when the engine couldn't resolve it. */
  grams: number | null;
  /** Baker's percentage (own grams ÷ flour grams); null when n/a. */
  bakerPct: number | null;
};

/** One recipe's rows, keyed by normalized ingredient name (see compareRowKey). */
export type RecipeRowMap = Map<string, RecipeRowEntry>;

/** Summary statistics across the recipes that share an ingredient (or a numeric
 * detail row). The compared recipes are the full population of interest, so the
 * standard deviation is population (÷n), not sample (÷n−1). */
export type Stats = {
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation. */
  std: number;
  /** Coefficient of variation (std ÷ |mean|) as a percent; null when mean is 0. */
  cv: number | null;
  /** How many recipes contributed a value. */
  count: number;
};

/** One ingredient row aligned across every compared recipe. */
type CompareRow = {
  key: string;
  label: string;
  isFlour: boolean;
  /**
   * Basis value per recipe column, in input order:
   * - a number (including `0` when the recipe doesn't list this ingredient — a
   *   true zero that counts toward the average),
   * - `null` when the recipe lists it but the amount couldn't be resolved (no
   *   weight/price data); shown as "·" and excluded from the average.
   */
  values: (number | null)[];
  /** Mean over present (non-null) values, counting absences as 0; null when none. */
  average: number | null;
  /** Cross-recipe summary stats over the present values; null when none. */
  stats: Stats | null;
  /** Largest absolute deviation among present values (for bar scaling); 0 when flat. */
  maxAbsDeviation: number;
  /** Column index of the largest deviation; null when flat or <2 present values. */
  maxDeviationIndex: number | null;
};

const DEV_EPSILON = 1e-6;

/** Summary stats over a set of present values. Returns null for an empty set. */
export const computeStats = (xs: number[]): Stats | null => {
  if (xs.length === 0) return null;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return {
    mean,
    min: Math.min(...xs),
    max: Math.max(...xs),
    std,
    cv: mean !== 0 ? (std / Math.abs(mean)) * 100 : null,
    count: n,
  };
};

/** Sum two nullable numbers, preserving null only when both are null. */
export const sumNullable = (
  a: number | null,
  b: number | null,
): number | null => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

/**
 * Union key for aligning the same ingredient across recipes: trimmed +
 * lowercased name. Import dedupe already collapses identical names to one
 * ingredient id, so this aligns shared ingredients (and defensively merges any
 * stray duplicate rows that resolved to different ids).
 */
export const compareRowKey = (name: string): string =>
  name.trim().toLowerCase();

/**
 * Auto-pick the deviation basis: baker's % when the set has a flour row with a
 * resolved percentage (baked goods), else grams (which works for any recipe).
 */
export const pickDefaultBasis = (perRecipe: RecipeRowMap[]): CompareBasis => {
  for (const map of perRecipe) {
    for (const entry of map.values()) {
      if (entry.isFlour && entry.bakerPct != null) return "baker";
    }
  }
  return "gram";
};

/**
 * Align every recipe's rows into shared rows keyed by ingredient, pick the basis
 * value per cell, and compute each row's average plus which column deviates most
 * from it. Pure — callers pass already-extracted RecipeRowMaps (one per recipe,
 * in column order).
 */
export const buildCompareRows = (
  perRecipe: RecipeRowMap[],
  basis: CompareBasis,
): CompareRow[] => {
  // Union of keys, remembering first-seen label and OR-ing the flour flag.
  const meta = new Map<string, { label: string; isFlour: boolean }>();
  for (const map of perRecipe) {
    for (const [key, entry] of map) {
      const existing = meta.get(key);
      if (existing) {
        existing.isFlour = existing.isFlour || entry.isFlour;
      } else {
        meta.set(key, { label: entry.label, isFlour: entry.isFlour });
      }
    }
  }

  const rows: CompareRow[] = [];
  for (const [key, { label, isFlour }] of meta) {
    const values = perRecipe.map((map) => {
      const entry = map.get(key);
      // Recipe doesn't list this ingredient → a true 0 that counts toward the
      // average (so all-purpose flour in 2 of 3 recipes averages 66.7%, not
      // 100%). Listed but unresolvable (no weight/price data, e.g. bread flour
      // with no mapping) → null: shown as "·" and excluded from the average.
      if (!entry) return 0;
      return (basis === "baker" ? entry.bakerPct : entry.grams) ?? null;
    });
    const present = values.filter((v): v is number => v != null);
    // Drop a row only when every recipe lists the ingredient but none resolved a
    // value (all "·") — there's nothing to compare. Rows with any 0 stay.
    if (present.length === 0) continue;
    // Average/spread are only meaningful when some recipe resolved a real amount.
    // A row whose only known cells are absent-zeros (the one recipe that lists it
    // couldn't be resolved) stays visible — so you can see which recipe uses it —
    // but shows no average, stats, or deviation.
    const hasSignal = present.some((v) => v > 0);
    const stats = hasSignal ? computeStats(present) : null;
    const average = stats?.mean ?? null;

    let maxAbsDeviation = 0;
    let maxDeviationIndex: number | null = null;
    if (average != null && present.length >= 2) {
      values.forEach((v, i) => {
        if (v == null) return;
        const dev = Math.abs(v - average);
        if (dev > maxAbsDeviation + DEV_EPSILON) {
          maxAbsDeviation = dev;
          maxDeviationIndex = i;
        }
      });
    }

    rows.push({
      key,
      label,
      isFlour,
      values,
      average,
      stats,
      maxAbsDeviation,
      maxDeviationIndex,
    });
  }

  // Flour first (the baker's-% anchor), then ingredients shared by more recipes,
  // then larger average amount, then label — a stable, scannable order.
  const presence = (r: CompareRow) => r.values.filter((v) => v != null).length;
  rows.sort((a, b) => {
    if (a.isFlour !== b.isFlour) return a.isFlour ? -1 : 1;
    const pc = presence(b) - presence(a);
    if (pc !== 0) return pc;
    const avgDiff = (b.average ?? 0) - (a.average ?? 0);
    if (Math.abs(avgDiff) > DEV_EPSILON) return avgDiff;
    return a.label.localeCompare(b.label);
  });

  return rows;
};
