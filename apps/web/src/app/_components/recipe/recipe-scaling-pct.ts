import type { IngredientDataItem, RecipeCosting } from "~/lib/recipe-costing";

// Scaling percentages for the "Spec" recipe view — Modernist Cuisine's SCALING
// column. This is baker's percentage with a *selectable* 100% base instead of
// flour-only. Computed purely in TS from the gram weight the costing engine
// already resolved per row (`row.priceInfo.gram`), so picking a new base is
// instant and needs no WASM round-trip. We read the resolved gram (the same
// figure this view shows in its QUANTITY column) rather than the engine's
// own-gram-based `bakerPct`, so the percentage and the printed grams agree.

/** Resolved gram weight for a row, or null when the line can't reach grams. */
export const gramsForRow = (row: IngredientDataItem): number | null => {
  const gram = row.priceInfo?.gram;
  return gram?.isOk() ? gram.value.value : null;
};

/**
 * Default 100% base row: the first flour the engine classified (baker's-
 * percentage parity), else the heaviest row with resolvable grams, else null
 * when nothing weighs in. The heaviest fallback keeps a sensible anchor for
 * non-baking recipes.
 */
export const pickDefaultBaseRowId = (costing: RecipeCosting): string | null => {
  const flour = costing.rows.find(
    (r) => gramsForRow(r) != null && costing.isFlourRows.get(r.id) === true,
  );
  if (flour) return flour.id;

  let bestId: string | null = null;
  let bestGrams = -1;
  for (const row of costing.rows) {
    const g = gramsForRow(row);
    if (g != null && g > bestGrams) {
      bestGrams = g;
      bestId = row.id;
    }
  }
  return bestId;
};

/**
 * Row id → percentage of the base row's grams (base = 100%), null when either
 * the row or the base has no resolvable grams. Scale-invariant: a uniform scale
 * factor cancels in the ratio.
 */
export const computeScalingPercentages = (
  costing: RecipeCosting,
  baseRowId: string | null,
): Map<string, number | null> => {
  const baseRow = baseRowId
    ? costing.rows.find((r) => r.id === baseRowId)
    : undefined;
  const baseGrams = baseRow ? gramsForRow(baseRow) : null;

  const out = new Map<string, number | null>();
  for (const row of costing.rows) {
    const g = gramsForRow(row);
    out.set(row.id, baseGrams && g != null ? (g / baseGrams) * 100 : null);
  }
  return out;
};

/**
 * Format a scaling percentage: one decimal below 10% so small-but-meaningful
 * amounts (salt, leavening, spices) don't collapse to a misleading "0%"; whole
 * percent at/above 10%. Mirrors the table view's Baker's % column.
 */
export const formatScalingPct = (pct: number): string => {
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded}%`;
};
