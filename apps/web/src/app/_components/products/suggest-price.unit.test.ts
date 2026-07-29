import { describe, expect, it } from "vitest";
import {
  type PriceSourceExpense,
  suggestPriceFromExpenses,
} from "./suggest-price";

const buy = (
  overrides: Partial<PriceSourceExpense> = {},
): PriceSourceExpense => ({
  cost: 100,
  date: "2025-01-01",
  vendor: "eBay",
  future: false,
  ...overrides,
});

describe("suggestPriceFromExpenses", () => {
  it("returns the most recent real expense", () => {
    const result = suggestPriceFromExpenses(
      [
        buy({ cost: 80, date: "2024-01-01", vendor: "Home Depot" }),
        buy({ cost: 120, date: "2026-03-01", vendor: "Acme Tools" }),
        buy({ cost: 95, date: "2025-06-01" }),
      ],
      1,
    );
    expect(result?.unitPrice).toBe(120);
    expect(result?.vendor).toBe("Acme Tools");
    expect(result?.quantity).toBe(1);
  });

  it("divides a multi-unit order by the quantity on hand", () => {
    // The real case this guards: four LINK boxes on one $238.94 line. Copying
    // the total across would value the product at 4x what a unit is worth.
    const result = suggestPriceFromExpenses([buy({ cost: 238.94 })], 4);
    expect(result?.unitPrice).toBe(59.74);
    expect(result?.paid).toBe(238.94);
    expect(result?.quantity).toBe(4);
  });

  it("ignores dispositions and planned spend", () => {
    // A sale (negative) and a planned buy say nothing about unit value.
    const result = suggestPriceFromExpenses(
      [
        buy({ cost: 60, date: "2025-01-01" }),
        buy({ cost: -45, date: "2026-01-01" }),
        buy({ cost: 999, date: "2026-06-01", future: true }),
      ],
      1,
    );
    expect(result?.unitPrice).toBe(60);
  });

  it("returns null when there is nothing real to go on", () => {
    expect(suggestPriceFromExpenses([], 1)).toBeNull();
    expect(
      suggestPriceFromExpenses([buy({ cost: -20 }), buy({ cost: null })], 1),
    ).toBeNull();
    expect(suggestPriceFromExpenses([buy({ future: true })], 1)).toBeNull();
  });

  it("falls back to no division when quantity is absent or unusable", () => {
    for (const qty of [0, 0.5, Number.NaN]) {
      const result = suggestPriceFromExpenses([buy({ cost: 75 })], qty);
      expect(result?.unitPrice).toBe(75);
      expect(result?.quantity).toBe(1);
    }
  });

  it("prefers a dated expense over an undated one", () => {
    const result = suggestPriceFromExpenses(
      [buy({ cost: 10, date: null }), buy({ cost: 30, date: "2024-02-02" })],
      1,
    );
    expect(result?.unitPrice).toBe(30);
  });
});
