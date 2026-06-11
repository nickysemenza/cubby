import type { WUnitMapping } from "@cubby/recipebridge";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  type BrandedFoodServingSizeUnit,
  branded_food_serving_size_unit,
  type FoodSummary,
  getNutrientKey,
  getNutrientUnitString,
  isTier1Nutrient,
  type NutrientKey,
} from "@cubby/usda-schemas";
import { wasm } from "~/lib/wasm";

// Parsed unit mapping result (source normalized from undefined to null)
interface ParsedUnitMappingResult extends Omit<WUnitMapping, "source"> {
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
 * Normalizes USDA branded food serving size units to standard units
 */
const normalizeBrandedFoodServingSizeUnit = (
  unit: BrandedFoodServingSizeUnit,
): string => {
  switch (unit) {
    case "GM":
    case "GRM":
      return "g";
    case "MC":
    case "MLT":
      return "ml";
    case "g":
    case "IU":
    case "MG":
    case "ml":
      return unit;
    default: {
      // Use assertNever for exhaustive checking
      const _exhaustive: never = unit;
      return _exhaustive;
    }
  }
};

/**
 * Strip a plural suffix from a household unit word ("scoops" → "scoop",
 * "pouches" → "pouch"). Mirrors the parser's own singularization so the unit we
 * emit matches how the same word parses on a recipe line.
 */
const singularizeUnitWord = (s: string): string => {
  if (s.endsWith("es")) {
    const base = s.slice(0, -2);
    if (/(ch|sh|ss|x|z)$/.test(base)) return base;
  }
  return s.length > 2 && s.endsWith("s") ? s.slice(0, -1) : s;
};

/**
 * Creates a unit mapping from branded food serving size info using WASM parsing
 */
const createServingMapping = (
  fdc_id: number,
  serving: {
    serving_size: number | null;
    serving_size_unit: string | null;
    household_serving_fulltext: string | null;
  },
): UnitMapping | undefined => {
  if (
    serving.serving_size === null ||
    serving.serving_size_unit === null ||
    serving.household_serving_fulltext === null
  ) {
    return undefined;
  }

  try {
    const p = wasm.parse_ingredient(serving.household_serving_fulltext);
    // Copy the last amount without mutating p.amounts — wasm.parse_ingredient
    // results are cached/shared and must be treated as immutable.
    const last = p.amounts.at(-1);
    if (last === undefined) {
      return undefined;
    }
    const b = { ...last };

    // INVARIANT: bare counts may enter the conversion graph only from *recipe
    // amounts*, never from serving metadata. In the unit graph "whole" ≡ "each"
    // ≡ the priced item, so emitting a bare serving COUNT here would let a
    // serving inherit the product's per-item price (e.g. ProMix fdc 576208:
    // household "2 SCOOPS" parses to `2 ⟨whole⟩` + name "SCOOPS" — unguarded,
    // 44.3 g = 2 whole made one scoop cost a whole $39.99 bag). Relabel the
    // bare count with the household word the parser read as the "name"
    // (normalized to match how that word parses on a recipe line), falling
    // back to a generic "serving" unit.
    if (b.unit === "whole" || b.unit === "") {
      const householdUnit = singularizeUnitWord(p.name.trim().toLowerCase());
      b.unit = householdUnit.length > 0 ? householdUnit : "serving";
    }
    const servingSizeUnit = branded_food_serving_size_unit.parse(
      serving.serving_size_unit,
    );
    return {
      a: {
        value: serving.serving_size,
        unit: normalizeBrandedFoodServingSizeUnit(servingSizeUnit),
      },
      b,
      source: `USDA FDC serving`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    };
  } catch {
    return undefined;
  }
};

/**
 * Converts a raw food portion to a unit mapping
 */
const unitMappingFromPortionInfo = (
  portionInfo: {
    amount: number;
    modifier: string | null;
    gram_weight: number;
  },
  fdc_id: number,
): UnitMapping => {
  return {
    a: {
      value: portionInfo.amount,
      unit: portionInfo.modifier ?? "portion",
    },
    b: {
      value: portionInfo.gram_weight,
      unit: "g",
    },
    source: `USDA portion`,
    sourceMetadata: { type: "food" as const, fdcId: fdc_id },
  };
};

/**
 * Creates unit mappings from nutrition data (e.g., 100g → 374kcal, 100g → 15g protein)
 * Generates mappings for all tier 1 nutrients from the generic nutrientsPer100 record.
 */
const unitMappingsFromNutrition = (food: FoodSummary): UnitMapping[] => {
  const nutrients = food.nutritionInfo?.nutrientsPer100;
  if (!nutrients) return [];
  const { fdc_id } = food;

  return Object.entries(nutrients)
    .filter(([code, amount]) => amount > 0 && isTier1Nutrient(code))
    .map(([code, amount]) => {
      const key = getNutrientKey(code) as NutrientKey;
      const unitStr = getNutrientUnitString(key);
      return {
        a: { value: 100, unit: "g" },
        b: { value: amount, unit: unitStr },
        // e.g., "g protein", "kcal", "mg sodium", "ug vitamin_b12"
        source: `USDA nutrition`,
        sourceMetadata: { type: "food" as const, fdcId: fdc_id },
      };
    });
};

export const unitMappingsFromFood = (food: FoodSummary): UnitMapping[] => {
  const { fdc_id, portionInfoRaw, brandedFoodInfo } = food;

  // Get serving size mapping from branded food info with WASM parsing
  const servingMapping = brandedFoodInfo?.serving
    ? createServingMapping(fdc_id, brandedFoodInfo.serving)
    : undefined;

  return [
    // Parse raw portions to unit mappings
    ...portionInfoRaw.map((p) => unitMappingFromPortionInfo(p, fdc_id)),
    ...(servingMapping ? [servingMapping] : []),
    ...unitMappingsFromNutrition(food),
  ];
};

/**
 * Builds the synthetic "1 each -> $price" costing edge from a product's price.
 *
 * Price is stored as the scalar `product.price` column (source of truth), not as
 * a unit-mapping row. We project it into the conversion graph here at compute
 * time — the same read-time synthesis pattern used for USDA food data — so recipe
 * costing can still convert an ingredient amount through to money.
 */
const priceMappingFromProduct = (
  price: number | null | undefined,
  productId?: ProductId,
): UnitMapping[] => {
  if (price == null) return [];
  return [
    {
      a: { value: 1, unit: "each" },
      b: { value: price, unit: "dollar" },
      source: "price",
      sourceMetadata: productId
        ? { type: "product", productId }
        : { type: "manual" },
    },
  ];
};

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
}): UnitMapping[] => {
  const foodMappings = product.food ? unitMappingsFromFood(product.food) : [];
  const priceMapping = priceMappingFromProduct(product.price, product.id);
  return [...product.unitMappings, ...foodMappings, ...priceMapping];
};

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
