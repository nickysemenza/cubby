import { beforeAll, describe, expect, it } from "vitest";
import { ensureWasm } from "~/lib/wasm";
import {
  computeInventoryValuation,
  isCanonicalPriceMapping,
  isMoneyUnit,
  truncateToTwoDecimals,
} from "./price-mapping-utils";

// Initialize WASM before tests run
beforeAll(async () => {
  await ensureWasm();
});

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
    // truncates to 2 decimal places
    { input: 12.999, expected: 13.0 },
    { input: 12.994, expected: 12.99 },
    { input: 12.995, expected: 13.0 },
    // very small values
    { input: 0.001, expected: 0.0 },
    { input: 0.005, expected: 0.01 },
    { input: 0.004, expected: 0.0 },
    // large values
    { input: 1000.0, expected: 1000.0 },
    { input: 9740.6784, expected: 9740.68 },
    { input: 1234567.895, expected: 1234567.9 },
    // exact 2-decimal values
    { input: 12.5, expected: 12.5 },
    { input: 99.99, expected: 99.99 },
    // negative values
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

describe("computeInventoryValuation", () => {
  const CASES: {
    name: string;
    amount: number;
    price: number | null;
    expected: number | null;
  }[] = [
    { name: "amount * price", amount: 5, price: 10.0, expected: 50.0 },
    // 2.5 * 4.99 = 12.475, truncated to 2 decimals = 12.48
    {
      name: "decimal values truncate",
      amount: 2.5,
      price: 4.99,
      expected: 12.48,
    },
    { name: "null price → null", amount: 5, price: null, expected: null },
    { name: "zero amount → 0", amount: 0, price: 10.0, expected: 0 },
  ];

  it.each(CASES)("$name", ({ amount, price, expected }) => {
    expect(computeInventoryValuation(amount, price)).toBe(expected);
  });
});
