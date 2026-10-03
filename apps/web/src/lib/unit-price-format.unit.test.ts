import { describe, expect, it } from "vitest";

import { formatUnitPrice } from "./unit-price-format";

describe("formatUnitPrice", () => {
  it("keeps sub-cent unit prices legible instead of rounding them to $0.00", () => {
    // The default 2-decimal money format renders $0.003/g as "$0.00", which
    // reads as free — worse than showing nothing at all.
    expect(formatUnitPrice(0.0030086)).toBe("$0.00301");
    expect(formatUnitPrice(0.0853125)).toBe("$0.085");
    expect(formatUnitPrice(15.29)).toBe("$15.29");
  });
});
