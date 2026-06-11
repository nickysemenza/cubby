import type { WFoodInput, WUnitMapping } from "@cubby/recipebridge";
import { type ProductId, unsafeProductId } from "@cubby/schemas/identifiers";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  type FoodSummary,
  getNutrientKey,
  getNutrientUnitString,
  isTier1Nutrient,
  type NutrientKey,
} from "@cubby/usda-schemas";
import type { ReadonlyDeep } from "type-fest";
import { wasm } from "~/lib/wasm";

// Mapping synthesis (portions, the bare-count-guarded serving edge, nutrition
// edges, the "1 each = $price" edge) lives in Rust — recipebridge's
// food_mappings module — so client display, server totals, and the costing
// engine all derive conversion edges from one implementation. This module is
// the thin boundary wrapper: project inputs, recast outputs.

// Parsed unit mapping result (source normalized from undefined to null)
interface ParsedUnitMappingResult
  extends Omit<WUnitMapping, "source" | "sourceMetadata"> {
  source: string | null;
}

/**
 * Parse a unit mapping string using WASM.
 * Supports formats: "4 lb = $5", "$5/4lb", "4 lb = $5 @ store"
 */
export const parseUnitMappingString = (
  input: string,
): ParsedUnitMappingResult => {
  const result = wasm.parse_unit_mapping(input);
  // Normalize undefined to null for source field
  return {
    a: result.a,
    b: result.b,
    source: result.source ?? null,
  };
};

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
  nutrients_per_100: Object.entries(food.nutritionInfo?.nutrientsPer100 ?? {})
    .filter(([code, amount]) => amount > 0 && isTier1Nutrient(code))
    .map(([code, amount]) => ({
      unit: getNutrientUnitString(getNutrientKey(code) as NutrientKey),
      amount,
    })),
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
          productId: unsafeProductId(m.sourceMetadata.productId),
        }
      : m.sourceMetadata?.type === "food"
        ? { type: "food", fdcId: m.sourceMetadata.fdcId }
        : { type: "manual" },
});

export const unitMappingsFromFood = (food: FoodSummary): UnitMapping[] =>
  wasm.unit_mappings_from_food(toWFoodInput(food)).map(toUnitMapping);

/**
 * Gets all unit mappings from a product: stored measurement conversions, plus
 * conversions derived from food data, plus the synthesized price edge.
 */
export const getAllUnitMappingsFromProduct = (product: {
  // All fields are required (not optional) on purpose: omitting one would
  // silently drop a synthesized edge — e.g. a missing `price` computes "no
  // cost" with no error. Required params make that a compile error instead.
  id: ProductId;
  unitMappings: UnitMapping[];
  food: FoodSummary | null;
  price: number | null;
}): UnitMapping[] =>
  wasm
    .product_unit_mappings({
      id: product.id,
      price: product.price,
      unit_mappings: product.unitMappings,
      food: product.food ? toWFoodInput(product.food) : null,
    })
    .map(toUnitMapping);

/**
 * Aggregates unit mappings from all products for an entity with multiple products
 * (e.g., an ingredient that has multiple linked products)
 */
export const getIngredientMappings = <
  T extends {
    product: Array<{
      id: ProductId;
      unitMappings: UnitMapping[];
      food: FoodSummary | null;
      price: number | null;
    }>;
  },
>(
  entity: T,
): UnitMapping[] => {
  return entity.product.flatMap((p) => getAllUnitMappingsFromProduct(p));
};
