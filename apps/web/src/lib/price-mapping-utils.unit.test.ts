import type { Amount } from "@cubby/schemas/codec";
import { testShortcode } from "@cubby/schemas/testing";

import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { describe, expect, it } from "vitest";
import {
  computeInventoryValuation,
  computeInventoryValuations,
  computePerUnitPrices,
  isCanonicalPriceMapping,
  isMoneyUnit,
  truncateToTwoDecimals,
} from "./price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "./unit-mapping-utils";

describe("isMoneyUnit", () => {
  const CASES: { unit: string; expected: boolean }[] = [
    { unit: "dollar", expected: true },
    { unit: "Dollar", expected: true }, // case insensitive
    { unit: "gram", expected: false },
    { unit: "kg", expected: false },
    { unit: "lb", expected: false },
    { unit: "each", expected: false },
    { unit: "ml", expected: false },
    { unit: "cup", expected: false },
  ];

  it.each(CASES)("$unit → $expected", ({ unit, expected }) => {
    expect(isMoneyUnit(unit)).toBe(expected);
  });
});

describe("truncateToTwoDecimals", () => {
  const CASES: { input: number; expected: number }[] = [
    { input: 12.999, expected: 13.0 },
    { input: 12.994, expected: 12.99 },
    { input: 12.995, expected: 13.0 },
    { input: 0.001, expected: 0.0 },
    { input: 0.005, expected: 0.01 },
    { input: 0.004, expected: 0.0 },
    { input: 1000.0, expected: 1000.0 },
    { input: 9740.6784, expected: 9740.68 },
    { input: 1234567.895, expected: 1234567.9 },
    { input: 12.5, expected: 12.5 },
    { input: 99.99, expected: 99.99 },
    { input: -12.999, expected: -13.0 },
    { input: -12.994, expected: -12.99 },
  ];

  it.each(CASES)("$input → $expected", ({ input, expected }) => {
    expect(truncateToTwoDecimals(input)).toBe(expected);
  });
});

describe("isCanonicalPriceMapping", () => {
  const CASES: {
    name: string;
    mapping: {
      a: { value: number; unit: string };
      b: { value: number; unit: string };
    };
    expected: boolean;
  }[] = [
    {
      name: "1 each ↔ money",
      mapping: {
        a: { value: 1, unit: "each" },
        b: { value: 9.99, unit: "dollar" },
      },
      expected: true,
    },
    {
      name: "money ↔ 1 each (reversed)",
      mapping: {
        a: { value: 5.99, unit: "dollar" },
        b: { value: 1, unit: "each" },
      },
      expected: true,
    },
    {
      name: "per-measure money mapping (allowed as costing edge)",
      mapping: {
        a: { value: 1, unit: "quart" },
        b: { value: 4, unit: "dollar" },
      },
      expected: false,
    },
    {
      name: "multi-count money mapping",
      mapping: {
        a: { value: 2, unit: "each" },
        b: { value: 8, unit: "dollar" },
      },
      expected: false,
    },
    {
      name: "pure measurement conversion",
      mapping: { a: { value: 1, unit: "each" }, b: { value: 5, unit: "lb" } },
      expected: false,
    },
  ];

  it.each(CASES)("$name", ({ mapping, expected }) => {
    expect(isCanonicalPriceMapping(mapping)).toBe(expected);
  });
});

/**
 * Valuation routes an amount to money through the product's own conversion
 * graph, so the graph is built the way production builds it — through
 * `getAllUnitMappingsFromProduct`, which is what synthesizes the `1 each =
 * $price` edge. Hand-writing that edge here would test a graph the app never
 * assembles.
 */
const graphFor = (
  price: number | null,
  stored: Array<{ a: Amount; b: Amount }> = [],
): UnitMapping[] =>
  getAllUnitMappingsFromProduct({
    id: testShortcode("product", "PRD-TEST"),
    unitMappings: stored.map((m) => ({ ...m, source: null })),
    food: null,
    price,
  });

const PACK_OF_FOUR = {
  a: { value: 1, unit: "each" },
  b: { value: 4, unit: "roll" },
};
const CAN_IS_WHOLE = {
  a: { value: 1, unit: "whole" },
  b: { value: 1, unit: "can" },
};

describe("computeInventoryValuation", () => {
  const CASES: {
    name: string;
    amount: Amount;
    mappings: UnitMapping[];
    expected: number | null;
  }[] = [
    {
      name: "sub-unit amount values through the pack mapping",
      amount: { value: 4, unit: "roll" },
      mappings: graphFor(8, [PACK_OF_FOUR]),
      expected: 8,
    },
    {
      name: "no path to money → null, never a naive multiply",
      amount: { value: 500, unit: "g" },
      mappings: graphFor(12),
      expected: null,
    },
    {
      name: "each amounts land on price × quantity",
      amount: { value: 5, unit: "each" },
      mappings: graphFor(10),
      expected: 50,
    },
    {
      name: "can amounts reach money via the whole↔can row",
      amount: { value: 8, unit: "can" },
      mappings: graphFor(5.5, [CAN_IS_WHOLE]),
      expected: 44,
    },
    {
      name: "whole agrees with each",
      amount: { value: 1, unit: "whole" },
      mappings: graphFor(10),
      expected: 10,
    },
    {
      name: "each agrees with whole",
      amount: { value: 1, unit: "each" },
      mappings: graphFor(10),
      expected: 10,
    },
    // Six live products are priced at $0. The synthesized edge is `1 each = $0`,
    // whose reverse direction is 1/0 — the `real` column must still never see
    // Infinity or NaN.
    {
      name: "$0 price values at 0, not null",
      amount: { value: 5, unit: "each" },
      mappings: graphFor(0),
      expected: 0,
    },
    {
      name: "no price at all → null",
      amount: { value: 5, unit: "each" },
      mappings: graphFor(null),
      expected: null,
    },
    {
      name: "zero amount → 0",
      amount: { value: 0, unit: "each" },
      mappings: graphFor(10),
      expected: 0,
    },
    {
      name: "decimal values round to cents",
      amount: { value: 2.5, unit: "each" },
      mappings: graphFor(4.99),
      expected: 12.48,
    },
  ];

  it.each(CASES)("$name", ({ amount, mappings, expected }) => {
    const result = computeInventoryValuation(amount, mappings);
    expect(result).toBe(expected);
    if (result !== null) expect(Number.isFinite(result)).toBe(true);
  });

  it("never returns a non-finite number the real column could store", () => {
    for (const { amount, mappings } of CASES) {
      const result = computeInventoryValuation(amount, mappings);
      expect(result === null || Number.isFinite(result)).toBe(true);
    }
  });
});

describe("computeInventoryValuations", () => {
  it("agrees with the single-amount path, elementwise", () => {
    const mappings = graphFor(8, [PACK_OF_FOUR]);
    const amounts: Amount[] = [
      { value: 4, unit: "roll" },
      { value: 2, unit: "each" },
      { value: 500, unit: "g" },
      { value: 1, unit: "roll" },
    ];
    expect(computeInventoryValuations(amounts, mappings)).toEqual(
      amounts.map((a) => computeInventoryValuation(a, mappings)),
    );
  });

  it("one unconvertible amount does not blank the rest of the batch", () => {
    expect(
      computeInventoryValuations(
        [
          { value: 500, unit: "g" },
          { value: 3, unit: "each" },
        ],
        graphFor(10),
      ),
    ).toEqual([null, 30]);
  });

  it("empty input is an empty batch", () => {
    expect(computeInventoryValuations([], graphFor(10))).toEqual([]);
  });
});

/**
 * The comparable unit price — what "$2.73 each" plus "1 each = 32 oz" is worth
 * per ounce, so an organic bag and a conventional one can be read side by side.
 *
 * Same graph construction as valuation above, for the same reason: the price
 * edge is synthesized by `getAllUnitMappingsFromProduct`, so asking the graph
 * for "1 oz in money" IS the whole computation. No new arithmetic exists here.
 */
const BAG_OF_32_OZ = {
  a: { value: 1, unit: "each" },
  b: { value: 32, unit: "oz" },
};
const BOTTLE_750_ML = {
  a: { value: 1, unit: "each" },
  b: { value: 750, unit: "ml" },
};
const OLIVE_OIL_DENSITY = {
  a: { value: 1, unit: "ml" },
  b: { value: 0.92, unit: "g" },
};

describe("computePerUnitPrices", () => {
  it("prices a bagged good per ounce and per gram", () => {
    const prices = computePerUnitPrices(graphFor(2.73, [BAG_OF_32_OZ]));
    expect(prices.natural?.unit).toBe("oz");
    expect(prices.natural?.price).toBeCloseTo(2.73 / 32, 6);
    expect(prices.perGram).toBeCloseTo(2.73 / (32 * 28.349523125), 6);
  });

  it("prefers a weight basis over each when the graph offers both", () => {
    expect(
      computePerUnitPrices(graphFor(2.73, [BAG_OF_32_OZ])).natural?.unit,
    ).not.toBe("each");
  });

  it("falls back to each for something with no measure at all", () => {
    expect(computePerUnitPrices(graphFor(178.29)).natural).toEqual({
      unit: "each",
      price: 178.29,
    });
    expect(computePerUnitPrices(graphFor(178.29)).perGram).toBeNull();
  });

  it("reaches grams for a volume product only through a density", () => {
    expect(
      computePerUnitPrices(graphFor(15.29, [BOTTLE_750_ML])).perGram,
    ).toBeNull();
    expect(
      computePerUnitPrices(graphFor(15.29, [BOTTLE_750_ML, OLIVE_OIL_DENSITY]))
        .perGram,
    ).toBeCloseTo(15.29 / (750 * 0.92), 6);
  });

  it("returns nothing when there is no price to route to", () => {
    expect(computePerUnitPrices(graphFor(null, [BAG_OF_32_OZ]))).toEqual({
      natural: null,
      perGram: null,
    });
  });

  it("reads a genuinely free product as $0, never as Infinity", () => {
    const prices = computePerUnitPrices(graphFor(0));
    expect(prices.natural?.price).toBe(0);
    expect(prices.perGram === null || Number.isFinite(prices.perGram)).toBe(
      true,
    );
  });

  it("short-circuits an empty graph without calling WASM", () => {
    expect(computePerUnitPrices([])).toEqual({ natural: null, perGram: null });
  });
});
