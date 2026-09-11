import type { NutritionTotals } from "@cubby/schemas/nutrition";

/**
 * Pending totals on an older recipe expose manual recovery when the background
 * drain may have stalled. Successfully computed unavailable values need no retry.
 */

// How long after a recipe's last edit we still assume the background drain is
// about to fill its totals. Past this window, expose manual recomputation.
export const TOTALS_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Raw missing totals and projected pending estimates share the recovery rule.
 */
export function totalsLookStuck(
  recipe: { totals?: Pick<NutritionTotals, "cost"> | null; updatedAt: Date },
  now: number = Date.now(),
): boolean {
  return (
    (recipe.totals == null || recipe.totals.cost.status === "pending") &&
    now - recipe.updatedAt.getTime() > TOTALS_STALE_AFTER_MS
  );
}
