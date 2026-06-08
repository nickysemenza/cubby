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
  it("returns true for dollar", () => {
    expect(isMoneyUnit("dollar")).toBe(true);
  });

  it("returns true for Dollar (case insensitive)", () => {
    expect(isMoneyUnit("Dollar")).toBe(true);
  });

  it("returns false for weight units", () => {
    expect(isMoneyUnit("gram")).toBe(false);
    expect(isMoneyUnit("kg")).toBe(false);
    expect(isMoneyUnit("lb")).toBe(false);
  });

  it("returns false for count units", () => {
    expect(isMoneyUnit("each")).toBe(false);
  });

  it("returns false for volume units", () => {
    expect(isMoneyUnit("ml")).toBe(false);
    expect(isMoneyUnit("cup")).toBe(false);
  });
});

describe("truncateToTwoDecimals", () => {
  it("truncates to 2 decimal places", () => {
    expect(truncateToTwoDecimals(12.999)).toBe(13.0);
    expect(truncateToTwoDecimals(12.994)).toBe(12.99);
    expect(truncateToTwoDecimals(12.995)).toBe(13.0);
  });

  it("handles very small values", () => {
    expect(truncateToTwoDecimals(0.001)).toBe(0.0);
    expect(truncateToTwoDecimals(0.005)).toBe(0.01);
    expect(truncateToTwoDecimals(0.004)).toBe(0.0);
  });

  it("handles large values", () => {
    expect(truncateToTwoDecimals(1000.0)).toBe(1000.0);
    expect(truncateToTwoDecimals(9740.6784)).toBe(9740.68);
    expect(truncateToTwoDecimals(1234567.895)).toBe(1234567.9);
  });

  it("handles exact 2-decimal values", () => {
    expect(truncateToTwoDecimals(12.5)).toBe(12.5);
    expect(truncateToTwoDecimals(99.99)).toBe(99.99);
  });

  it("handles negative values", () => {
    expect(truncateToTwoDecimals(-12.999)).toBe(-13.0);
    expect(truncateToTwoDecimals(-12.994)).toBe(-12.99);
  });
});

describe("isCanonicalPriceMapping", () => {
  it("detects 1 each <-> money in both directions", () => {
    expect(
      isCanonicalPriceMapping({
        a: { value: 1, unit: "each" },
        b: { value: 9.99, unit: "dollar" },
      }),
    ).toBe(true);
    expect(
      isCanonicalPriceMapping({
        a: { value: 5.99, unit: "dollar" },
        b: { value: 1, unit: "each" },
      }),
    ).toBe(true);
  });

  it("rejects per-measure money mappings (allowed as costing edges)", () => {
    expect(
      isCanonicalPriceMapping({
        a: { value: 1, unit: "quart" },
        b: { value: 4, unit: "dollar" },
      }),
    ).toBe(false);
    expect(
      isCanonicalPriceMapping({
        a: { value: 2, unit: "each" },
        b: { value: 8, unit: "dollar" },
      }),
    ).toBe(false);
  });

  it("rejects pure measurement conversions", () => {
    expect(
      isCanonicalPriceMapping({
        a: { value: 1, unit: "each" },
        b: { value: 5, unit: "lb" },
      }),
    ).toBe(false);
  });
});

describe("computeInventoryValuation", () => {
  it("computes valuation as amount * price", () => {
    const valuation = computeInventoryValuation(5, 10.0);
    expect(valuation).toBe(50.0);
  });

  it("handles decimal values correctly", () => {
    const valuation = computeInventoryValuation(2.5, 4.99);
    // 2.5 * 4.99 = 12.475, truncated to 2 decimals = 12.48
    expect(valuation).toBe(12.48);
  });

  it("returns null when product price is null", () => {
    const valuation = computeInventoryValuation(5, null);
    expect(valuation).toBeNull();
  });

  it("returns 0 when amount is 0", () => {
    const valuation = computeInventoryValuation(0, 10.0);
    expect(valuation).toBe(0);
  });
});
