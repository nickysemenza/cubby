/**
 * Display-time ratios of numbers the Rust costing engine has already
 * computed — nutrient density (protein per 100 kcal) and price-per-nutrient
 * (cost per gram of protein). These are scalar re-expressions of figures the
 * engine already produced, the same category as `perServingRange`
 * (recipe-utils.ts) and the price/weight ratio in
 * command-menu/use-conversion-answer.ts — plain division of two numbers a
 * caller already has in hand. Do NOT add unit-conversion or costing logic
 * here: a conversion between two *different* units (grams to cups, an amount
 * to a price) still belongs in WASM (`recipebridge`'s `conv_amount_to_kind` /
 * costing engine); this module only divides numbers those already produced.
 *
 * For a {value, upper} range's single sort/compare key, reuse
 * `rangeMidpoint` from `~/lib/format-range` — don't duplicate it here.
 */

const isFiniteNumber = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value);

/**
 * Cost per unit of a nutrient (e.g. $ / g protein) — cost ÷ nutrientAmount.
 * Null unless both are finite numbers and the amount is strictly positive (a
 * zero/negative/missing denominator has no meaningful per-unit price).
 */
export function costPerNutrient(
  cost: number | null | undefined,
  nutrientAmount: number | null | undefined,
): number | null {
  if (!isFiniteNumber(cost) || !isFiniteNumber(nutrientAmount)) return null;
  if (nutrientAmount <= 0) return null;
  return cost / nutrientAmount;
}

/**
 * Protein density per 100 kcal — protein ÷ kcal × 100. Null unless both are
 * finite numbers and kcal is strictly positive.
 */
export function proteinPer100Kcal(
  protein: number | null | undefined,
  kcal: number | null | undefined,
): number | null {
  if (!isFiniteNumber(protein) || !isFiniteNumber(kcal)) return null;
  if (kcal <= 0) return null;
  return (protein / kcal) * 100;
}
