import { type NutrientKey, TIER1_NUTRIENTS } from "@cubby/usda";

// Core nutrients we surface an at-a-glance coverage row for. Code + tooltip name
// derive from TIER1_NUTRIENTS by key (no raw nutrient_nbr here); `short` is the
// badge label, the one per-surface override. Order is the display order
// (calories first, to match the nutrition chips). Presence (not value) is what
// counts — a 0-calorie food still "has" a kcal datum.
const CORE_NUTRIENT_BADGES = [
  ["kcal", "Cal"],
  ["protein", "P"],
  ["carbs", "C"],
  ["sodium", "Na"],
] as const satisfies ReadonlyArray<readonly [NutrientKey, string]>;

export const CORE_NUTRIENTS = CORE_NUTRIENT_BADGES.map(([key, short]) => ({
  code: TIER1_NUTRIENTS[key].code,
  short,
  name: TIER1_NUTRIENTS[key].displayName,
}));

/** Total distinct nutrient data points present on a food. */
export function nutrientCount(nutrientsPer100: Record<string, number>): number {
  return Object.keys(nutrientsPer100).length;
}
