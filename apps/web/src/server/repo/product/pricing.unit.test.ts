import { describe, expect, it } from "vitest";
import { MAX_KIT_PROJECTION_DEPTH } from "./kit-projection";
import { effectiveProductPriceSql, resolveProductPricing } from "./pricing";
import { expectedQuantitySql } from "./quantity-ledger";

describe("resolveProductPricing", () => {
  it("uses a weighted all-history unit cost", () => {
    expect(
      resolveProductPricing(null, {
        knownCost: 34,
        knownExpenseCount: 2,
        unknownExpenseCount: 0,
        knownUnitCount: 5,
      }),
    ).toEqual({
      derivedPrice: 6.8,
      effectivePrice: 6.8,
      source: "derived",
      knownExpenseCount: 2,
      unknownExpenseCount: 0,
      knownUnitCount: 5,
      partial: false,
    });
  });

  it("keeps the manual override while exposing partial derivation", () => {
    expect(
      resolveProductPricing(9.99, {
        knownCost: 10,
        knownExpenseCount: 1,
        unknownExpenseCount: 2,
        knownUnitCount: 3,
      }),
    ).toEqual({
      derivedPrice: 3.33,
      effectivePrice: 9.99,
      source: "explicit",
      knownExpenseCount: 1,
      unknownExpenseCount: 2,
      knownUnitCount: 3,
      partial: true,
    });
  });

  it("does not invent a price when every quantity is unknown", () => {
    expect(
      resolveProductPricing(null, {
        knownCost: 0,
        knownExpenseCount: 0,
        unknownExpenseCount: 3,
        knownUnitCount: 0,
      }),
    ).toEqual({
      derivedPrice: null,
      effectivePrice: null,
      source: "none",
      knownExpenseCount: 0,
      unknownExpenseCount: 3,
      knownUnitCount: 0,
      partial: false,
    });
  });
});

/**
 * The kit projection's arithmetic, stated as the aggregate it is specified to
 * produce. The recursive walk that BUILDS these aggregates is SQL and is pinned
 * in `kit-projection.integration.test.ts`; what is decidable from inputs alone
 * is what the blended numbers then mean as a price, which is this.
 */
describe("resolveProductPricing over a projected kit share", () => {
  it("prices a nine-part kit at its per-part share", () => {
    // $199 × 1/9 projected onto one unit.
    expect(
      resolveProductPricing(null, {
        knownCost: 199 / 9,
        knownExpenseCount: 0,
        unknownExpenseCount: 0,
        knownUnitCount: 1,
      }).derivedPrice,
    ).toBe(22.11);
  });

  it("gives a doubled component twice the money and twice the units", () => {
    // A $30 kit holding one of A and two of B: A takes $10 over one unit, B
    // takes $20 over two. Weighting both sides is what keeps the per-unit price
    // the same across a kit — the share is not a discount for buying two.
    const single = resolveProductPricing(null, {
      knownCost: 10,
      knownExpenseCount: 0,
      unknownExpenseCount: 0,
      knownUnitCount: 1,
    });
    const doubled = resolveProductPricing(null, {
      knownCost: 20,
      knownExpenseCount: 0,
      unknownExpenseCount: 0,
      knownUnitCount: 2,
    });
    expect(doubled.knownUnitCount).toBe(2 * single.knownUnitCount);
    expect(doubled.derivedPrice).toBe(single.derivedPrice);
  });

  it("blends own expenses with the projected share", () => {
    // $40 projected over one unit plus a $20 standalone buy over one unit.
    expect(
      resolveProductPricing(null, {
        knownCost: 60,
        knownExpenseCount: 1,
        unknownExpenseCount: 0,
        knownUnitCount: 2,
      }),
    ).toMatchObject({
      derivedPrice: 30,
      effectivePrice: 30,
      source: "derived",
    });
  });

  it("lets an explicit override beat the projection outright", () => {
    expect(
      resolveProductPricing(3.5, {
        knownCost: 90,
        knownExpenseCount: 0,
        unknownExpenseCount: 0,
        knownUnitCount: 1,
      }),
    ).toMatchObject({
      derivedPrice: 90,
      effectivePrice: 3.5,
      source: "explicit",
    });
  });
});

describe("effectiveProductPriceSql", () => {
  // Golden-SQL guard for the raw-SQL twin of `loadProductPricing` (used by
  // Product root-list filtering/sorting/aggregation, where a real query can't
  // easily be asserted against). Both twins must select on
  // `lineKind = 'principal'` in lockstep with the drizzle query in
  // `loadProductPricing` — a tax/shipping/fee row carrying a productId must
  // never contribute to the derived price. This test would have caught the
  // regression where neither twin filtered on lineKind at all.
  it("filters the derived-price subquery to principal Expense lines", () => {
    expect(effectiveProductPriceSql()).toContain(
      `kpe."lineKind" = 'principal'`,
    );
  });

  // Both correlated twins walk `ProductComponent` recursively, and the bound is
  // the only thing stopping a pre-existing cycle from spinning inside a
  // `WITH RECURSIVE` — a read path cannot assume the graph is acyclic. Deleting
  // it typechecks, passes every arithmetic test, and hangs the Product list.
  it.each([
    ["derived price", effectiveProductPriceSql()],
    ["expected quantity", expectedQuantitySql()],
  ])("caps the kit walk in the %s twin", (_label, generated) => {
    expect(generated).toContain(`ka.depth < ${MAX_KIT_PROJECTION_DEPTH}`);
  });
});
