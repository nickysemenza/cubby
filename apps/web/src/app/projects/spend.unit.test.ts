import { describe, expect, it } from "vitest";
import { budgetRemaining, splitPurchaseSpend } from "./spend";

describe("splitPurchaseSpend", () => {
  it("returns all zeroes for an empty list", () => {
    expect(splitPurchaseSpend([])).toEqual({
      actual: 0,
      committed: 0,
      contributions: 0,
      net: 0,
    });
  });

  it("classifies actual (positive, not future)", () => {
    const split = splitPurchaseSpend([
      { cost: 100, future: false },
      { cost: 250, future: false },
    ]);
    expect(split).toEqual({
      actual: 350,
      committed: 0,
      contributions: 0,
      net: 350,
    });
  });

  it("classifies committed (positive, future)", () => {
    const split = splitPurchaseSpend([
      { cost: 100, future: false },
      { cost: 400, future: true },
    ]);
    expect(split).toEqual({
      actual: 100,
      committed: 400,
      contributions: 0,
      net: 500,
    });
  });

  it("treats negative purchases as contributions (positive magnitude) that offset net", () => {
    // Mirrors the Wedding project: family contributions are negative, future rows.
    const split = splitPurchaseSpend([
      { cost: 60_000, future: false },
      { cost: 46_600, future: true },
      { cost: -50_000, future: true },
      { cost: -25_000, future: true },
    ]);
    expect(split.actual).toBe(60_000);
    expect(split.committed).toBe(46_600);
    expect(split.contributions).toBe(75_000);
    expect(split.net).toBe(60_000 + 46_600 - 75_000);
  });

  it("ignores null and zero costs", () => {
    const split = splitPurchaseSpend([
      { cost: null, future: false },
      { cost: 0, future: true },
      { cost: 42, future: false },
    ]);
    expect(split).toEqual({
      actual: 42,
      committed: 0,
      contributions: 0,
      net: 42,
    });
  });

  it("net always equals actual + committed − contributions (matches rollup.spent)", () => {
    const purchases = [
      { cost: 10, future: false },
      { cost: 20, future: true },
      { cost: -5, future: false },
      { cost: null, future: false },
    ];
    const split = splitPurchaseSpend(purchases);
    const rawSum = purchases.reduce((t, p) => t + (p.cost ?? 0), 0);
    expect(split.net).toBe(rawSum);
    expect(split.net).toBe(
      split.actual + split.committed - split.contributions,
    );
  });
});

describe("budgetRemaining", () => {
  const split = splitPurchaseSpend([
    { cost: 60_000, future: false },
    { cost: 46_600, future: true },
    { cost: -75_000, future: true },
  ]);

  it("is null when there is no estimate", () => {
    expect(budgetRemaining(null, split)).toBeNull();
  });

  it("subtracts net spend from the estimate", () => {
    expect(budgetRemaining(175_000, split)).toBe(175_000 - split.net);
  });

  it("can go negative when net exceeds the estimate", () => {
    const over = splitPurchaseSpend([{ cost: 200, future: false }]);
    expect(budgetRemaining(150, over)).toBe(-50);
  });
});

// A product's net cost basis (ProductPurchaseHistory) reuses this split rather
// than summing costs directly: a bare sum would blend planned rows into money
// actually spent, and NaN out on the null costs the ledger genuinely carries.
describe("net cost basis over a product's linked purchases", () => {
  const netCost = (purchases: Parameters<typeof splitPurchaseSpend>[0]) => {
    const split = splitPurchaseSpend(purchases);
    return split.actual - split.contributions;
  };

  it("nets an acquisition against a later sale", () => {
    expect(
      netCost([
        { cost: 180, future: false },
        { cost: -150, future: false },
      ]),
    ).toBe(30);
  });

  it("is zero for a full return", () => {
    expect(
      netCost([
        { cost: 180, future: false },
        { cost: -180, future: false },
      ]),
    ).toBe(0);
  });

  it("treats a 0-cost disposal as leaving the basis untouched", () => {
    expect(
      netCost([
        { cost: 180, future: false },
        { cost: 0, future: false },
      ]),
    ).toBe(180);
  });

  it("contributes nothing (not NaN) for a null cost", () => {
    expect(
      netCost([
        { cost: 180, future: false },
        { cost: null, future: false },
      ]),
    ).toBe(180);
  });

  it("excludes planned rows — they are not money out the door", () => {
    expect(
      netCost([
        { cost: 180, future: false },
        { cost: 500, future: true },
      ]),
    ).toBe(180);
  });
});
