import { baseKind } from "@cubby/schemas/problems";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { safeConvertAmount } from "~/lib/recipe-costing";

/**
 * Conversion coverage — how "complete" a product's unit graph is, across the
 * four base measurement kinds (weight, volume, money, calories).
 *
 * Source of truth is the real unit-graph: each of the 6 base-kind pairs is
 * probed with `safeConvertAmount` (the same engine the costing rollup uses), so
 * the result reflects actual convertibility — chained graph paths included — not
 * a structural guess. The detail view renders the per-pair grid; compact (table)
 * cells render the kind icons, lit when a kind participates in any working
 * conversion. Both read from this one result, so they never disagree.
 *
 * (Probes are directional, matching the original capabilities grid: density
 * bridges are one-directional, so e.g. weight→volume and volume→weight aren't
 * the same test.)
 */

// Single-sourced from the `baseKind` Zod enum so the problem schemas' coverage
// type and this costing module share one definition of the four kinds.
export const BASE_KINDS = baseKind.options;
export type BaseKind = (typeof BASE_KINDS)[number];

/**
 * Kind set for USDA foods. A USDA record has no price by definition, so money
 * can never participate — grading it against the full 4-kind universe would peg
 * every food below "complete". Restricting to weight/volume/calories lets a
 * fully-convertible USDA food read as "complete".
 */
export const USDA_KINDS = ["weight", "volume", "calories"] as const;

export type CoverageTier = "complete" | "good" | "partial" | "none";

interface CoveragePair {
  from: BaseKind;
  to: BaseKind;
  success: boolean;
}

interface ConversionCoverage {
  /** Base kinds that participate in at least one working conversion (lit icons). */
  covered: Set<BaseKind>;
  /** |covered| ∈ {0,2,3,4} (a lone kind has no pair, so never 1). */
  kindsCovered: number;
  /** The 6 base-kind pairs, for the detail grid. */
  pairs: CoveragePair[];
  tier: CoverageTier;
}

// One directional probe per grid cell, in display order.
const PROBES: { unit: string; from: BaseKind; to: BaseKind }[] = [
  { unit: "g", from: "weight", to: "volume" },
  { unit: "g", from: "weight", to: "money" },
  { unit: "g", from: "weight", to: "calories" },
  { unit: "ml", from: "volume", to: "money" },
  { unit: "ml", from: "volume", to: "calories" },
  { unit: "$", from: "money", to: "calories" },
];

export function conversionCoverage(
  mappings: UnitMapping[],
  kinds: readonly BaseKind[] = BASE_KINDS,
): ConversionCoverage {
  // Only probe pairs whose endpoints are both in the requested kind universe, so
  // e.g. USDA foods (weight/volume/calories) aren't graded against money.
  const kindSet = new Set(kinds);
  const pairs: CoveragePair[] = PROBES.filter(
    (p) => kindSet.has(p.from) && kindSet.has(p.to),
  ).map((p) => ({
    from: p.from,
    to: p.to,
    success: safeConvertAmount(
      { unit: p.unit, value: 1 },
      mappings,
      p.to,
    ).isOk(),
  }));

  // A kind is "covered" (lit) if it's an endpoint of any working conversion —
  // i.e. the icons are exactly a summary of the green cells in the grid.
  const covered = new Set<BaseKind>();
  for (const pair of pairs) {
    if (pair.success) {
      covered.add(pair.from);
      covered.add(pair.to);
    }
  }

  // Tiers are relative to the size of the requested universe so the thresholds
  // hold for both 4-kind (products: 4→complete, 3→good, 2→partial) and 3-kind
  // (USDA: 3→complete, 2→good).
  const total = kinds.length;
  const kindsCovered = covered.size;
  const tier: CoverageTier =
    kindsCovered >= total
      ? "complete"
      : kindsCovered >= total - 1
        ? "good"
        : kindsCovered >= 2
          ? "partial"
          : "none";

  return { covered, kindsCovered, pairs, tier };
}
