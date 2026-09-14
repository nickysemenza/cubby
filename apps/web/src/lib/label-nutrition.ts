import type { WUnitMapping } from "@cubby/recipebridge";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import {
  buildNutrients,
  type FoodSummary,
  getNutrientKey,
  getNutrientUnitString,
  isNutrientKey,
  isTier1Nutrient,
  type NutrientKey,
  type NutrientsPer100,
} from "@cubby/usda-schemas";

// A per-product label-nutrition override synthesizes the same shape of edges
// USDA nutrition does (recipebridge's `nutrition_mappings`: `100 g = X <unit>`)
// so it can slot into the same unit graph at the TS→WASM boundary — nothing in
// Rust changes. Precedence is label > fdc_id (USDA) > none, enforced by
// `productWasmInputs` in `unit-mapping-utils.ts`, which drops the USDA
// nutrient edges (keeping portions/serving) when a label is present.

/**
 * Scale a label's per-serving amounts to per-100 g, keyed by USDA nutrient
 * code — the same shape `nutrients_per_100`/`NutrientsPer100` already use.
 * Stored per stated serving (what the package prints); this is the only place
 * that does the per-100 g conversion.
 */
export const labelNutrientsPer100 = (
  label: ProductLabelNutrition,
): NutrientsPer100 => {
  const scaled: Partial<Record<NutrientKey, number>> = {};
  for (const [key, value] of Object.entries(label.nutrients)) {
    if (value != null && isNutrientKey(key)) {
      scaled[key] = (value / label.servingGrams) * 100;
    }
  }
  return buildNutrients(scaled);
};

/**
 * One `100 g = X <unit>` edge per labelled nutrient, provenance-tagged to this
 * product — the label's counterpart to `unitMappingsFromFood`'s USDA nutrient
 * edges. Mirrors Rust's `nutrition_mappings` guard (skip non-finite/negative
 * amounts) so a malformed label can't poison the unit graph.
 */
export const labelNutritionMappings = (
  productId: ProductShortcode,
  label: ProductLabelNutrition,
): WUnitMapping[] => {
  const per100 = labelNutrientsPer100(label);
  const mappings: WUnitMapping[] = [];
  for (const [code, value] of Object.entries(per100)) {
    if (!Number.isFinite(value) || value < 0 || !isTier1Nutrient(code)) {
      continue;
    }
    mappings.push({
      a: { value: 100, unit: "g" },
      b: { value, unit: getNutrientUnitString(getNutrientKey(code)) },
      source: "label nutrition",
      sourceMetadata: { type: "product", productId },
    });
  }
  return mappings;
};

/**
 * Which source a product's nutrition contribution comes from. Precedence:
 * label > fdc_id (USDA) > none — a label supersedes USDA outright rather than
 * combining with it (see `productWasmInputs`), so this is a strict priority
 * order, not a union.
 */
export const productNutritionSource = (p: {
  labelNutrition: ProductLabelNutrition | null;
  food: FoodSummary | null;
}): "label" | "usda" | "none" => {
  if (p.labelNutrition != null) return "label";
  if (p.food != null) return "usda";
  return "none";
};
