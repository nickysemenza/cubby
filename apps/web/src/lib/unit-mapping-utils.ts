import type { WFoodInput, WUnitMapping } from "@cubby/recipebridge";
import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  type FoodSummary,
  getNutrientKey,
  getNutrientUnitString,
  isTier1Nutrient,
} from "@cubby/usda-schemas";
import type { ReadonlyDeep } from "type-fest";

import { labelNutritionMappings } from "~/lib/label-nutrition";
import { wasm } from "~/lib/wasm";

// Mapping synthesis (portions, the bare-count-guarded serving edge, nutrition
// edges, the "1 each = $price" edge) lives in Rust — recipebridge's
// food_mappings module — so client display, server totals, and the costing
// engine all derive conversion edges from one implementation. This module is
// the thin boundary wrapper: project inputs, recast outputs.

/**
 * Project a `FoodSummary` down to the WASM synthesis input (the
 * mapping-relevant subset). Tier-1 filtering and conversion-target labeling
 * ("g protein", "kcal") happen here so `TIER1_NUTRIENTS` stays TS-owned —
 * usda-api shares the package and must not need WASM.
 */
export const toWFoodInput = (food: FoodSummary): WFoodInput => ({
  fdc_id: food.fdc_id,
  portions: food.portionInfoRaw.map((p) => ({
    amount: p.amount,
    modifier: p.modifier,
    gram_weight: p.gram_weight,
  })),
  serving: food.brandedFoodInfo?.serving ?? null,
  nutrients_per_100: Object.entries(
    food.nutritionInfo?.nutrientsPer100 ?? {},
  ).flatMap(([code, amount]) =>
    amount >= 0 && Number.isFinite(amount) && isTier1Nutrient(code)
      ? [
          {
            unit: getNutrientUnitString(getNutrientKey(code)),
            amount,
          },
        ]
      : [],
  ),
});

/**
 * Recast a WASM-synthesized mapping to the TS `UnitMapping`: brand the product
 * id, normalize the optional source/metadata to the required shape. Fresh
 * objects — the WASM proxy's cached results are shared/readonly. The metadata
 * fallback is defensive: every edge this boundary emits carries it.
 */
const toUnitMapping = (m: ReadonlyDeep<WUnitMapping>): UnitMapping => ({
  a: { value: m.a.value, unit: m.a.unit },
  b: { value: m.b.value, unit: m.b.unit },
  source: m.source ?? null,
  sourceMetadata:
    m.sourceMetadata?.type === "product"
      ? {
          type: "product",
          productId: parseShortcodeFor("product", m.sourceMetadata.productId),
        }
      : m.sourceMetadata?.type === "food"
        ? { type: "food", fdcId: m.sourceMetadata.fdcId }
        : { type: "manual" },
});

export const unitMappingsFromFood = (food: FoodSummary): UnitMapping[] =>
  wasm.unit_mappings_from_food(toWFoodInput(food)).map(toUnitMapping);

/**
 * The unit USDA's per-100 nutrient figures are stated in for this food ("g",
 * or "ml" for mL-serving branded foods). Derived from the synthesized
 * mappings so the Rust normalizer (`nutrient_basis_unit` in
 * `food_mappings.rs`) stays the single source of truth.
 */
export const usdaNutrientBasis = (mappings: UnitMapping[]): "g" | "ml" =>
  mappings.find((m) => m.source === "USDA nutrition")?.a.unit === "ml"
    ? "ml"
    : "g";

/**
 * The unit USDA's per-100 nutrient figures are stated in for this food's
 * serving metadata, when only the food (not its synthesized mappings) is
 * available. Mirrors `normalize_serving_size_unit` in `food_mappings.rs`:
 * `MLT`/`MC`/`ml` mean the label's serving is stated in mL, anything else
 * (including no serving at all) defaults to `g`.
 */
export const servingBasisUnit = (
  food: Pick<FoodSummary, "brandedFoodInfo"> | null | undefined,
): "g" | "ml" => {
  const unit = food?.brandedFoodInfo?.serving?.serving_size_unit;
  return unit === "MLT" || unit === "MC" || unit === "ml" ? "ml" : "g";
};

/**
 * The shared `{unit_mappings, food}` half of a WASM product-mapping input —
 * used by both `toWProductInput` (recipe-costing's batch WASM call) and
 * `getAllUnitMappingsFromProduct` (the product/ingredient detail pages' mapping
 * lists and coverage chips), so the two surfaces can't disagree about label
 * precedence.
 *
 * Precedence is label > fdc_id (USDA) > none: a `labelNutrition` override
 * synthesizes its own `100 g = X <unit>` edges and the USDA nutrient edges are
 * dropped outright (`nutrients_per_100: []`) rather than merged — the label
 * wins, it doesn't supplement. USDA's portion/serving weight edges are kept
 * either way; only the nutrient contribution is a precedence choice.
 */
export const productWasmInputs = (product: {
  id: ProductShortcode;
  unitMappings: WUnitMapping[];
  food: FoodSummary | null;
  labelNutrition: ProductLabelNutrition | null;
}): Pick<WProductInputLike, "unit_mappings" | "food"> => {
  if (product.labelNutrition == null) {
    return {
      unit_mappings: product.unitMappings,
      food: product.food ? toWFoodInput(product.food) : null,
    };
  }
  return {
    unit_mappings: [
      ...product.unitMappings,
      ...labelNutritionMappings(product.id, product.labelNutrition),
    ],
    food: product.food
      ? { ...toWFoodInput(product.food), nutrients_per_100: [] }
      : null,
  };
};

/** The subset of `WProductInput` {@link productWasmInputs} projects. */
type WProductInputLike = {
  unit_mappings: WUnitMapping[];
  food: WFoodInput | null;
};

/**
 * Gets all unit mappings from a product: stored measurement conversions, plus
 * conversions derived from food data (or a label nutrition override, which
 * supersedes it), plus the synthesized price edge.
 */
export const getAllUnitMappingsFromProduct = (product: {
  // All fields are required (not optional) on purpose: omitting one would
  // silently drop a synthesized edge — e.g. a missing `price` computes "no
  // cost" with no error. Required params make that a compile error instead.
  id: ProductShortcode;
  // Stored mappings are only forwarded to WASM, which treats `sourceMetadata`
  // as optional — so accept the metadata-less shape (`WUnitMapping`) too. This
  // lets server callers pass raw DB rows (a/b/source) without synthesizing the
  // provenance the synthesis ignores.
  unitMappings: WUnitMapping[];
  food: FoodSummary | null;
  labelNutrition: ProductLabelNutrition | null;
  price: number | null;
  pricing?: { effectivePrice: number | null };
}): UnitMapping[] =>
  wasm
    .product_unit_mappings({
      id: product.id,
      price: product.pricing?.effectivePrice ?? product.price,
      ...productWasmInputs(product),
    })
    .map(toUnitMapping);

/**
 * Aggregates unit mappings from all products for an entity with multiple products
 * (e.g., an ingredient that has multiple linked products)
 */
export const getIngredientMappings = <
  T extends {
    product: Array<{
      id: ProductShortcode;
      unitMappings: UnitMapping[];
      food: FoodSummary | null;
      labelNutrition: ProductLabelNutrition | null;
      price: number | null;
      pricing?: { effectivePrice: number | null };
    }>;
  },
>(
  entity: T,
): UnitMapping[] => {
  return entity.product.flatMap((p) => getAllUnitMappingsFromProduct(p));
};
