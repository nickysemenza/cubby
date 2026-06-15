import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";

/**
 * Core nutrients we surface an at-a-glance coverage row for. Codes are USDA
 * nutrient_nbr values (see usda-schemas nutrient-codes). `short` is the badge
 * label, `name` the tooltip. Order is the display order (calories first, to match
 * the nutrition chips). Presence (not value) is what counts — a 0-calorie food
 * still "has" a kcal datum.
 */
export const CORE_NUTRIENTS = [
  { code: "208", short: "Cal", name: "Calories" },
  { code: "203", short: "P", name: "Protein" },
  { code: "205", short: "C", name: "Carbs" },
  { code: "307", short: "Na", name: "Sodium" },
] as const;

/** Total distinct nutrient data points present on a food. */
export function nutrientCount(nutrientsPer100: Record<string, number>): number {
  return Object.keys(nutrientsPer100).length;
}

export interface DedupedFood {
  food: FoodSummaryWithLinkedProducts;
  /** Number of additional records collapsed into this one (0 when unique). */
  duplicateCount: number;
}

// Higher tuple sorts as "more complete". Compared lexicographically: most
// nutrients first, then a named brand, then an ingredient list, then the newest
// record (highest fdc_id) as a stable tiebreak.
function completenessKey(f: FoodSummaryWithLinkedProducts): number[] {
  return [
    Object.keys(f.nutritionInfo.nutrientsPer100).length,
    f.brandedFoodInfo?.brand_name ? 1 : 0,
    f.brandedFoodInfo?.ingredients ? 1 : 0,
    f.fdc_id,
  ];
}

function moreComplete(
  a: FoodSummaryWithLinkedProducts,
  b: FoodSummaryWithLinkedProducts,
): boolean {
  const ka = completenessKey(a);
  const kb = completenessKey(b);
  for (let i = 0; i < ka.length; i++) {
    const av = ka[i] ?? 0;
    const bv = kb[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/**
 * Collapse USDA records that share a UPC into one row, keeping the most-complete
 * record and counting the rest. USDA's Branded database accumulates repeated
 * submissions of the same product (same UPC, new fdc_id) over time, so a name
 * search returns many near-identical rows. Foods without a UPC (foundation /
 * legacy / survey) are genuinely distinct and pass through untouched. First-seen
 * order is preserved so the existing sort still drives the list.
 */
export function dedupeUsdaFoodsByUpc(
  foods: FoodSummaryWithLinkedProducts[],
): DedupedFood[] {
  const byUpc = new Map<string, DedupedFood>();
  const result: DedupedFood[] = [];

  for (const food of foods) {
    const upc = food.brandedFoodInfo?.gtin_upc;
    if (!upc) {
      result.push({ food, duplicateCount: 0 });
      continue;
    }
    const existing = byUpc.get(upc);
    if (!existing) {
      const entry: DedupedFood = { food, duplicateCount: 0 };
      byUpc.set(upc, entry);
      result.push(entry);
    } else {
      existing.duplicateCount += 1;
      if (moreComplete(food, existing.food)) existing.food = food;
    }
  }

  return result;
}
