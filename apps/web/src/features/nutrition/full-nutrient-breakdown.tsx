import type { NutritionInfo } from "@cubby/usda";

import { Disclosure } from "~/ui/layout/disclosure";

import { NutritionInfoTable } from "../usda-food/nutrition";

/**
 * `NutritionLabel` renders only the 22 TIER1_NUTRIENTS; `nutrientSummary` is
 * the full, unbounded USDA nutrient join (B-vitamin variants, fatty-acid
 * breakdowns, amino acids, sugars) that a straight swap to the FDA-style
 * label would silently drop. This keeps the raw table reachable — collapsed
 * by default so it doesn't compete with the label for first-paint attention,
 * expanded on demand for the full breakdown.
 */
export function FullNutrientBreakdown({
  nutritionInfo,
}: {
  nutritionInfo: NutritionInfo;
}) {
  if (nutritionInfo.nutrientSummary.length === 0) return null;

  return (
    <Disclosure
      summary="Full nutrient breakdown"
      meta={nutritionInfo.nutrientSummary.length}
    >
      <NutritionInfoTable n={nutritionInfo} />
    </Disclosure>
  );
}
