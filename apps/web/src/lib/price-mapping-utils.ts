import type { Amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { convertAmountsToPrice } from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";

/**
 * Checks if a unit represents money/currency using WASM.
 */
export const isMoneyUnit = (unit: string): boolean => {
  try {
    return wasm.amount_kind({ value: 1, unit }) === "money";
  } catch {
    return false;
  }
};

const isSingleEach = (a: Amount): boolean => a.value === 1 && a.unit === "each";

/**
 * A canonical price mapping is "1 each <-> $X" (in either direction).
 *
 * This is the ONE form that duplicates the `product.price` column (per-each
 * price), so it's forbidden in unit mappings and migrated to the column. Other
 * money mappings — per-measure prices like "1 quart = $4" for generic
 * ingredients that have no discrete "each" — are allowed: the scalar column
 * can't express them, so they legitimately live as conversion edges and feed
 * recipe costing directly.
 */
export const isCanonicalPriceMapping = (mapping: {
  a: Amount;
  b: Amount;
}): boolean =>
  (isSingleEach(mapping.a) && isMoneyUnit(mapping.b.unit)) ||
  (isSingleEach(mapping.b) && isMoneyUnit(mapping.a.unit));

/**
 * Truncate a monetary value to 2 decimal places (cents precision).
 * Uses rounding to avoid floating-point errors.
 */
export const truncateToTwoDecimals = (value: number): number => {
  return Math.round(value * 100) / 100;
};

/**
 * Cents-rounded money, or `null` for a value the `real` valuation column must
 * never receive. `Infinity`/`NaN` are reachable from a real graph — a product
 * priced at $0 synthesizes `1 each = $0`, whose reverse edge is `1/0` — and
 * Postgres would happily store the resulting `Infinity`, poisoning every sum
 * that reads the column.
 */
const toStorableMoney = (value: number): number | null =>
  Number.isFinite(value) ? truncateToTwoDecimals(value) : null;

/**
 * Value one inventory entry by routing its amount to money through the
 * product's unit-mapping graph.
 *
 * Price is deliberately NOT a parameter: `product_unit_mappings` synthesizes
 * `1 each = $price` into every product's mapping set, so the price is already
 * an edge. Multiplying `amount.value` by a per-each price instead — as this
 * used to — reads `{value: 500, unit: "g"}` on a $12 product as $6,000, and
 * four rolls off an $8 four-pack as $32.
 *
 * `null` means "no path from this unit to money", which subsumes the old
 * "product has no price" case. There is deliberately no naive-multiplication
 * fallback (that is the bug) and no `"each"` special case in TS (that
 * hand-copies the Rust edge, and would miss `whole`/`eaches`, which normalize
 * to the same unit upstream).
 */
export const computeInventoryValuation = (
  amount: Amount,
  mappings: readonly UnitMapping[],
): number | null => computeInventoryValuations([amount], mappings)[0] ?? null;

/**
 * {@link computeInventoryValuation} for a batch sharing one mapping graph —
 * every live entry of a product whose price just moved, say. One WASM call
 * builds the conversion graph once; output is positional, and a whole-call
 * failure values nothing rather than throwing mid-write.
 */
export const computeInventoryValuations = (
  amounts: readonly Amount[],
  mappings: readonly UnitMapping[],
): (number | null)[] => {
  if (amounts.length === 0) return [];
  const results = convertAmountsToPrice(amounts, mappings);
  if (results.isErr()) return amounts.map(() => null);
  return results.value.map((m) => (m.ok ? toStorableMoney(m.value) : null));
};

/**
 * Candidate bases for a comparable unit price, in preference order.
 *
 * The kind is NOT probed first. Every basis is offered to the graph in one call
 * and whichever resolves wins — the graph's actual capability is the honest
 * test, and a category guess would get a 32 oz bag of onions wrong: it is
 * bought by the `each` and still wants `$/oz`. Weight leads for exactly that
 * reason, `each` trails as the fallback for something genuinely countable.
 */
const PER_UNIT_BASES = ["oz", "fl oz", "each"] as const;
const GRAM_BASIS = "g";

export type PerUnitPrices = {
  /** The most natural basis this product's graph can actually reach. */
  natural: { unit: string; price: number } | null;
  /**
   * Price per gram, whenever the graph reaches mass. Direct for a weight
   * product; for a volume one it resolves only through a density edge — and its
   * absence is itself the signal that recording a density is worth doing.
   */
  perGram: number | null;
};

/**
 * The comparable unit price — what `$2.73 for 32 oz` is actually worth per
 * ounce, so an organic bag and a conventional one can be read side by side.
 *
 * Price is not a parameter for the same reason it isn't in
 * {@link computeInventoryValuation}: `1 each = $price` is already synthesized
 * into the graph, so asking for "1 oz in money" is the whole computation.
 *
 * Values are returned RAW, deliberately unrounded. `toStorableMoney`'s 2-decimal
 * truncation is right for a valuation column and wrong here — onions at
 * $0.0031/g would truncate to $0.00 and read as free. Rounding is the display
 * layer's job, at a precision it picks per magnitude.
 */
export const computePerUnitPrices = (
  mappings: readonly UnitMapping[],
): PerUnitPrices => {
  if (mappings.length === 0) return { natural: null, perGram: null };
  const probes: Amount[] = [
    ...PER_UNIT_BASES.map((unit) => ({ value: 1, unit })),
    { value: 1, unit: GRAM_BASIS },
  ];
  const results = convertAmountsToPrice(probes, mappings);
  if (results.isErr()) return { natural: null, perGram: null };

  // Non-finite is reachable from a real graph — a $0 product synthesizes
  // `1 each = $0`, whose reverse edge is 1/0 — so it must read as "no price",
  // never as a rendered Infinity.
  const priceAt = (index: number): number | null => {
    const measure = results.value[index];
    if (!measure?.ok || !Number.isFinite(measure.value)) return null;
    return measure.value;
  };

  let natural: PerUnitPrices["natural"] = null;
  for (const [index, unit] of PER_UNIT_BASES.entries()) {
    const price = priceAt(index);
    if (price !== null) {
      natural = { unit, price };
      break;
    }
  }
  return { natural, perGram: priceAt(PER_UNIT_BASES.length) };
};
