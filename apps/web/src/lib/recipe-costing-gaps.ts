import type { RecipeCosting } from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

/**
 * The single highest-leverage fix we suggest for an uncosted ingredient.
 *
 * Ordering reflects leverage: linking a product (and a USDA food) unlocks the
 * most at once, so it ranks above adding individual mappings. The two price
 * variants are unit-aware — a per-each price costs a *count* line ("2 zucchini")
 * directly, but can't reach a *weight/volume* line ("1 tsp cumin"), which needs
 * a purchase mapping that bridges weight↔money (e.g. "4 oz = $5.99").
 */
export type CostingGapKind =
  | "no-product" // ingredient has no product → link one
  | "link-usda" // product(s) exist but none USDA-linked, and weight is missing
  | "set-per-item-price" // count line, no per-each price yet
  | "add-purchase-mapping" // weight/volume line, no money path → package mapping
  | "add-weight-mapping"; // has price but can't reach grams

/** What kind of measurement the recipe line uses, for tailoring price copy. */
export type LineKind = "count" | "weight" | "volume";

export interface CostingGap {
  ingredientId: string;
  name: string;
  /** Single-product → deep-link target; null routes to the ingredient hub. */
  productId: string | null;
  /** The recipe line's primary unit (drives the example in the suggestion). */
  lineUnit: string | null;
  lineKind: LineKind;
  /** Which measures the engine couldn't resolve for this ingredient. */
  missing: { price: boolean; weight: boolean; nutrients: boolean };
  /** The prioritized fix to suggest. */
  kind: CostingGapKind;
}

// Priority rank for sorting — lower sorts first (highest leverage on top).
const KIND_RANK: Record<CostingGapKind, number> = {
  "no-product": 0,
  "link-usda": 1,
  "set-per-item-price": 2,
  "add-purchase-mapping": 2,
  "add-weight-mapping": 3,
};

/**
 * Classify a recipe line's unit into the kind that drives the price suggestion.
 * The engine's `amount_kind` has no "count" bucket — discrete units like "each"
 * or "clove" fall through to "other"/length/etc., which we treat as count.
 */
const classifyLine = (unit: string | null): LineKind => {
  if (!unit) return "count";
  try {
    const k = wasm.amount_kind({ value: 1, unit });
    if (k === "weight") return "weight";
    if (k === "volume") return "volume";
  } catch {
    // Unknown unit → treat as a count (the common "2 eggs" / "1 zucchini" case).
  }
  return "count";
};

interface GapAccumulator {
  name: string;
  productId: string | null;
  lineUnit: string | null;
  lineKind: LineKind;
  products: IngredientWithFoodOut["product"];
  missing: { price: boolean; weight: boolean; nutrients: boolean };
}

const classifyKind = (acc: GapAccumulator): CostingGapKind => {
  if (acc.products.length === 0) return "no-product";

  // A product is USDA-associated if it carries (or intends to carry) food data:
  // resolved `food`, or an fdc_id/UPC link whose lookup may be transiently missing.
  const usdaLinked = acc.products.some(
    (p) => p.food != null || p.fdc_id != null || p.upc != null,
  );
  const hasPrice = acc.products.some((p) => p.price != null);

  // Weight missing with no USDA link → linking adds portion (+ nutrient)
  // conversions out of the box, the single biggest win.
  if (acc.missing.weight && !usdaLinked) return "link-usda";

  if (acc.missing.price) {
    // A per-each price can't cost a weight/volume line; it needs a purchase
    // mapping that bridges weight↔money. Same when a count line already has a
    // price but still can't resolve (unit mismatch) — a bridging mapping helps.
    if (acc.lineKind === "weight" || acc.lineKind === "volume") {
      return "add-purchase-mapping";
    }
    return hasPrice ? "add-purchase-mapping" : "set-per-item-price";
  }

  // Price resolved but weight didn't (and a USDA link already exists / price is
  // set) → a direct weight mapping is the remaining fix.
  return "add-weight-mapping";
};

/**
 * Derive the prioritized list of mapping suggestions for a recipe's uncosted
 * ingredients. Walks the engine's per-row results once (the reliable id-bearing
 * signal — same source as the old weight-only `missingWeightLinks`), dedupes by
 * ingredient, and classifies each into its single highest-leverage fix.
 *
 * Only ingredients missing a price OR a weight are returned (the costing-
 * relevant gaps); a nutrient-only miss on an already-linked product isn't user-
 * actionable here, so it's skipped. Sub-recipe rows are a different problem and
 * are ignored, as are unmeasured lines (to-taste seasoning, garnish, …) that
 * carry no amount — no mapping can cost a quantity that was never given.
 */
export const deriveCostingGaps = (
  costing: RecipeCosting,
  ingMap: Record<string, IngredientWithFoodOut>,
): CostingGap[] => {
  const byId = new Map<string, GapAccumulator>();

  for (const row of costing.rows) {
    if (row.type !== "ingredient") continue;
    // Skip unmeasured lines (salt "to taste", a garnish — no amount at all). No
    // mapping can cost a quantity that was never given, so suggesting one is just
    // noise; the engine already treats these as estimates.
    if (row.amounts.length === 0) continue;
    const pi = row.priceInfo;
    const priceMissing = !pi || pi.price.isErr();
    const weightMissing = !pi || pi.gram.isErr();
    const nutrientMissing = !pi || pi.nutrient.isErr();
    if (!priceMissing && !weightMissing) continue; // costed & weighable → fine

    const id = row.ingredient.id;
    const existing = byId.get(id);
    if (existing) {
      // Same ingredient on multiple lines: a gap in any line is a gap overall.
      existing.missing.price ||= priceMissing;
      existing.missing.weight ||= weightMissing;
      existing.missing.nutrients ||= nutrientMissing;
      continue;
    }

    const products = ingMap[id]?.product ?? [];
    const lineUnit = row.amounts[0]?.unit ?? null;
    byId.set(id, {
      name: row.ingredient.name,
      productId: products.length === 1 ? products[0]!.id : null,
      lineUnit,
      lineKind: classifyLine(lineUnit),
      products,
      missing: {
        price: priceMissing,
        weight: weightMissing,
        nutrients: nutrientMissing,
      },
    });
  }

  const gaps: CostingGap[] = [];
  for (const [ingredientId, acc] of byId) {
    gaps.push({
      ingredientId,
      name: acc.name,
      productId: acc.productId,
      lineUnit: acc.lineUnit,
      lineKind: acc.lineKind,
      missing: acc.missing,
      kind: classifyKind(acc),
    });
  }

  // Highest-leverage fixes first; ties keep input order (stable name grouping).
  return gaps.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
};
