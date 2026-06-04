import type { AmountKind, WAmount } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import type {
  RecipeOut,
  RecipeYield,
  SectionIngredientOut,
} from "@cubby/schemas/recipe";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  getNutrientUnitString,
  type NutrientKey,
  type NutrientsPer100,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";
import { err, ok } from "neverthrow";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Result } from "~/misc/result-types";
import type {
  IngredientWithFoodOut,
  ProductWithMappingsAndFoodOut,
} from "~/server/services/ingredient.service";

/**
 * Get nutrient target unit strings for WASM batch conversion
 * Format: "g protein", "mg sodium", etc.
 * NOTE: kcal is excluded - it must use conv_amount_to_kind("calories") instead
 * because WASM treats Unit::KCal differently from Unit::Other("kcal")
 */
const getNutrientTargets = (): { key: NutrientKey; target: string }[] => {
  return (Object.keys(TIER1_NUTRIENTS) as NutrientKey[])
    .filter((key) => key !== "kcal") // kcal handled separately via conv_amount_to_kind
    .map((key) => ({
      key,
      target: getNutrientUnitString(key),
    }));
};

/**
 * Convert an amount directly to all nutrients via WASM graph traversal
 * This replaces the old TypeScript-based scaling approach
 *
 */
export const convertAmountToNutrients = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<NutrientsPer100> => {
  try {
    const targets = getNutrientTargets();

    // Batch convert to all nutrient targets in a single WASM call (one entry per
    // target, in request order).
    const results = wasm.conv_amount_to_nutrients(
      mappings,
      targets.map((t) => t.target),
      amount,
    );

    // Map each converted target back to its nutrient code.
    const targetToKey = new Map(targets.map((t) => [t.target, t.key] as const));
    const nutrients: NutrientsPer100 = {};
    for (const { target, amount: converted } of results) {
      const key = targetToKey.get(target);
      if (converted && key) {
        nutrients[TIER1_NUTRIENTS[key].code] = converted.value;
      }
    }

    // Handle kcal separately using conv_amount_to_kind("calories")
    // This is needed because WASM treats Unit::KCal differently from Unit::Other("kcal")
    // MeasureKind::Nutrient("kcal") creates Unit::Other("kcal"), but mappings use Unit::KCal
    try {
      const kcalResult = wasm.conv_amount_to_kind(mappings, "calories", amount);
      if (kcalResult) {
        const kcalCode = TIER1_NUTRIENTS.kcal.code;
        nutrients[kcalCode] = kcalResult.value;
      }
    } catch {
      // kcal conversion failed - this is fine, just means no path exists
    }

    // Check if we got any nutrients
    if (Object.keys(nutrients).length === 0) {
      return err("No nutrient conversions succeeded");
    }

    return ok(nutrients);
  } catch (e) {
    return err(`Error converting to nutrients: ${e}`);
  }
};

/**
 * Creates an empty nutrients record
 *
 */
export const createEmptyNutrients = (): NutrientsPer100 =>
  ({}) as NutrientsPer100;

/**
 * Generic function to safely convert amounts using wasm
 */
export const safeConvertAmount = (
  amount: Amount,
  mappings: UnitMapping[],
  kind: AmountKind,
): Result<WAmount> => {
  try {
    const result = wasm.conv_amount_to_kind(mappings, kind, amount);
    return ok(result);
  } catch (e) {
    return err(`Error converting to ${kind}: ${e}`);
  }
};

/**
 * Converts an amount to a price measure
 */
export const convertAmountToPrice = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<WAmount> => {
  return safeConvertAmount(amount, mappings, "money");
};

/**
 * Extracts gram and nutrient results separately using WASM for both conversions.
 * Weight and nutrient conversions are now independent - both use the graph.
 *
 */
export const getGramAndNutrient = (
  amount: Amount,
  mappings: UnitMapping[],
  _product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WAmount>; nutrient: Result<NutrientsPer100> } => {
  // Convert amount to weight via WASM graph
  const gramResult = safeConvertAmount(amount, mappings, "weight");

  // Convert amount to nutrients via WASM graph (independent of weight conversion)
  const nutrientResult = convertAmountToNutrients(amount, mappings);

  return {
    gram: gramResult,
    nutrient: nutrientResult,
  };
};

/**
 * Sums multiple nutrient records, combining all nutrient codes
 */
const sumNutrients = (nutrients: NutrientsPer100[]): NutrientsPer100 => {
  const result: NutrientsPer100 = {};
  for (const n of nutrients) {
    for (const [code, amount] of Object.entries(n)) {
      result[code] = (result[code] ?? 0) + (amount ?? 0);
    }
  }
  return result;
};

/**
 * Builds a manual unit mapping for sub-recipe yield scaling.
 */
const makeYieldMapping = (a: Amount, b: Amount): UnitMapping => ({
  a,
  b,
  source: "sub-recipe",
  sourceMetadata: { type: "manual" },
});

/**
 * Expresses a sub-recipe's computed totals as unit mappings relative to its
 * yield (e.g. "1 batch = $C = W g = N g protein = M kcal"). Feeding the parent's
 * amount through these mappings via the existing WASM conversions yields the
 * yield-scaled cost/weight/nutrient contribution — "2 cups of a recipe yielding
 * 4 cups" contributes half its totals.
 */
const buildYieldMappings = (
  recipeYield: RecipeYield,
  totals: CalculateTotalsResult,
): UnitMapping[] => {
  const yieldAmount: Amount = {
    value: recipeYield.value,
    unit: recipeYield.unit,
  };
  const mappings: UnitMapping[] = [
    makeYieldMapping(yieldAmount, { value: totals.price, unit: "dollar" }),
    makeYieldMapping(yieldAmount, { value: totals.weight, unit: "g" }),
  ];
  // One mapping per nutrient present in the sub-recipe totals. getNutrientUnitString
  // returns "kcal" for the kcal key, matching the calories conversion path.
  for (const key of Object.keys(TIER1_NUTRIENTS) as NutrientKey[]) {
    const value = totals.nutrients[TIER1_NUTRIENTS[key].code];
    if (value == null) continue;
    mappings.push(
      makeYieldMapping(yieldAmount, {
        value,
        unit: getNutrientUnitString(key),
      }),
    );
  }
  return mappings;
};

/**
 * Computes a sub-recipe's totals and returns yield-relative mappings, or null
 * when it can't be costed: the sub-recipe wasn't fetched, has no yield to scale
 * against, or a cycle was detected (A → B → A). `visited` guards the cycle.
 */
const getSubRecipeMappings = (
  subId: string,
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut>,
  visited: Set<string>,
): UnitMapping[] | null => {
  if (visited.has(subId)) return null; // cycle guard
  const sub = recipeMap[subId];
  if (!sub || sub.yield == null) return null;

  const subTotals = calculateTotals(
    sub.sections.flatMap((s) => s.ingredients),
    ingMap,
    (ing) => ing.id, // nested missing-data labels are discarded; identity is fine
    recipeMap,
    new Set([...visited, subId]),
  );
  return buildYieldMappings(sub.yield, subTotals);
};

type IngredientMeasures = {
  price: Result<WAmount>;
  gram: Result<WAmount>;
  nutrient: Result<NutrientsPer100>;
};

/**
 * Converts one amount to price, weight, and all nutrients in a single WASM call
 * (`conv_amount_all` builds the unit-mapping graph once and returns every
 * measure), then reshapes into the `{ price, gram, nutrient }` Result trio. This
 * replaces the per-ingredient fan-out of convertAmountToPrice + getGramAndNutrient
 * (4 boundary crossings) on the costing hot path; the granular helpers stay for
 * their other callers.
 */
const measuresFromMappings = (
  amount: Amount,
  mappings: UnitMapping[],
): IngredientMeasures => {
  try {
    const targets = getNutrientTargets();
    const all = wasm.conv_amount_all(
      mappings,
      targets.map((t) => t.target),
      amount,
    );

    // Map each converted nutrient target back to its code; kcal rides in the
    // dedicated `calories` field (same Unit::KCal handling the old code did
    // separately).
    const targetToKey = new Map(targets.map((t) => [t.target, t.key] as const));
    const nutrients: NutrientsPer100 = {};
    for (const { target, amount: converted } of all.nutrients) {
      const key = targetToKey.get(target);
      if (converted && key) {
        nutrients[TIER1_NUTRIENTS[key].code] = converted.value;
      }
    }
    if (all.calories) {
      nutrients[TIER1_NUTRIENTS.kcal.code] = all.calories.value;
    }

    return {
      price: all.money ? ok(all.money) : err("Error converting to money"),
      gram: all.weight ? ok(all.weight) : err("Error converting to weight"),
      nutrient:
        Object.keys(nutrients).length === 0
          ? err("No nutrient conversions succeeded")
          : ok(nutrients),
    };
  } catch (e) {
    const error = `Error converting amount: ${e}`;
    return { price: err(error), gram: err(error), nutrient: err(error) };
  }
};

/**
 * Gets price, weight, and nutrient information for an ingredient.
 *
 * For recipe-as-ingredient (sub-recipe) entries, rolls up the sub-recipe's own
 * totals — scaled by amount/yield — instead of treating it as missing data.
 */
const getIngredientMeasures = (
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut> = {},
  visited: Set<string> = new Set(),
): IngredientMeasures => {
  const firstAmount = ingredient.amounts[0];

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: err(error),
      gram: err(error),
      nutrient: err(error),
    };
  }

  // Sub-recipe: build mappings from the sub-recipe's rolled-up totals, then
  // scale by the amount used via the same conversion as a normal ingredient.
  if (ingredient.type === "recipe") {
    const mappings = getSubRecipeMappings(
      ingredient.recipe.id,
      ingMap,
      recipeMap,
      visited,
    );
    if (!mappings) {
      const error = `sub-recipe ${ingredient.recipe.id} could not be costed`;
      return { price: err(error), gram: err(error), nutrient: err(error) };
    }
    return measuresFromMappings(firstAmount, mappings);
  }

  const entry = ingMap[ingredient.ingredient.id];
  const product = entry?.product;
  const mappings = (product ?? []).flatMap((p) =>
    getAllUnitMappingsFromProduct(p),
  );

  return measuresFromMappings(firstAmount, mappings);
};

export type CalculateTotalsResult = {
  price: number;
  nutrients: NutrientsPer100;
  weight: number;
  totalIngredients: number;
  missingByType: {
    price: string[];
    weight: string[];
    nutrients: string[];
  };
};

/**
 * Calculates price, weight, and nutrient information for a list of ingredients
 */
export const calculateTotals = (
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientWithFoodOut>,
  getIngredientName: (ingredient: SectionIngredientOut) => string,
  recipeMap: Record<string, RecipeOut> = {},
  visited: Set<string> = new Set(),
): CalculateTotalsResult => {
  const prices: WAmount[] = [];
  const grams: WAmount[] = [];
  const nutrients: NutrientsPer100[] = [];
  const missingByType = {
    price: [] as string[],
    weight: [] as string[],
    nutrients: [] as string[],
  };

  for (const ingredient of ingredients) {
    const ingName = getIngredientName(ingredient);
    try {
      const { price, gram, nutrient } = getIngredientMeasures(
        ingredient,
        ingMap,
        recipeMap,
        visited,
      );

      if (price.isOk()) {
        prices.push(price.value);
      } else {
        missingByType.price.push(ingName);
      }

      if (gram.isOk()) {
        grams.push(gram.value);
      } else {
        missingByType.weight.push(ingName);
      }

      if (nutrient.isOk()) {
        nutrients.push(nutrient.value);
      } else {
        missingByType.nutrients.push(ingName);
      }
    } catch (e) {
      console.error(`Error calculating measures for ${ingName}`, e);
      // If there's a general error, add to all missing categories
      missingByType.price.push(ingName);
      missingByType.weight.push(ingName);
      missingByType.nutrients.push(ingName);
    }
  }

  // Calculate totals
  const totalPrice = prices.reduce((acc, curr) => acc + (curr.value || 0), 0);
  const totalWeight = grams.reduce((acc, curr) => acc + curr.value, 0);
  const totalNutrients = sumNutrients(nutrients);

  return {
    price: totalPrice,
    nutrients: totalNutrients,
    weight: totalWeight,
    totalIngredients: ingredients.length,
    missingByType,
  };
};

type IngredientPriceInfo = {
  price: Result<WAmount>;
  gram: Result<WAmount>;
  nutrient: Result<NutrientsPer100>;
};

export type IngredientDataItem = SectionIngredientOut & {
  priceInfo: IngredientPriceInfo | undefined;
};

/**
 * Creates a wrapper for tracking ingredient data with price/nutrient info
 */
export const createIngredientData = (
  ingredients: SectionIngredientOut[],
  ingMap: Record<string, IngredientWithFoodOut> | undefined,
  recipeMap: Record<string, RecipeOut> = {},
): IngredientDataItem[] => {
  return ingredients.map((i) => ({
    ...i,
    priceInfo: ingMap ? getIngredientMeasures(i, ingMap, recipeMap) : undefined,
  }));
};
