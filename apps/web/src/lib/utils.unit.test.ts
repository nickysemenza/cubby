import { describe, expect, it } from "vitest";

import {
  formatCompactCount,
  formatCompactCurrency,
  formatCount,
  formatCurrency,
  formatPercent,
} from "./utils";

describe("number formatters", () => {
  it("formatCurrency pins the default $-and-cents shape", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });

  it("formatCurrency accepts an explicit minimum fraction digits", () => {
    expect(formatCurrency(0.0001234, 6, { minimumFractionDigits: 4 })).toBe(
      "$0.000123",
    );
  });

  it("formatCompactCurrency pins compact notation", () => {
    expect(formatCompactCurrency(1234567)).toBe("$1.2M");
  });

  it("formatCount pins thousands separators", () => {
    expect(formatCount(1240)).toBe("1,240");
  });

  it("formatCompactCount pins compact notation", () => {
    expect(formatCompactCount(1240)).toBe("1.2K");
  });

  it("formatPercent pins the default one-decimal shape", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
  });

  it("formatPercent's signDisplay is opt-in", () => {
    expect(formatPercent(0.05, { signDisplay: "exceptZero" })).toBe("+5%");
  });
});
