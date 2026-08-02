import { describe, expect, it } from "vitest";
import { resolveProductPricing } from "./pricing";

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
