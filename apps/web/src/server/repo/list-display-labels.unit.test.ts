import { describe, expect, it } from "vitest";

import {
  estimateLabel,
  expectedQuantityLabel,
  expenseCountLabel,
  mealCostLabel,
  quantityVarianceLabel,
  reconciliationLabel,
  settlementLabel,
  totalTimeLabel,
  unitPriceLabel,
  valuationLabel,
} from "./list-display-labels";

const ledger = (
  overrides: Partial<Parameters<typeof expectedQuantityLabel>[0]>,
) => ({
  acquiredUnits: 8,
  exitedUnits: 2,
  expectedQuantity: 6,
  unknownAcquisitionLines: 0,
  unknownExitLines: 0,
  locationCount: 0,
  ...overrides,
});

describe("expectedQuantityLabel", () => {
  it("prints the bare count when every line carried a quantity", () => {
    expect(expectedQuantityLabel(ledger({}))).toBe("6");
  });

  // An unquantified receipt line contributes nothing to the number, so a
  // product with unknowns must never read as a confident count.
  it("discloses unquantified acquisition and exit lines in both directions", () => {
    expect(
      expectedQuantityLabel(
        ledger({ unknownAcquisitionLines: 2, unknownExitLines: 1 }),
      ),
    ).toBe("6 +2? −1?");
  });
});

describe("quantityVarianceLabel", () => {
  it("signs a surplus, leaves a zero bare, and is absent when unknown", () => {
    expect(quantityVarianceLabel(2)).toBe("+2");
    expect(quantityVarianceLabel(-3)).toBe("-3");
    expect(quantityVarianceLabel(0)).toBe("0");
    expect(quantityVarianceLabel(null)).toBeNull();
  });
});

describe("estimateLabel", () => {
  const coverage = { covered: 3, total: 3 };
  it("formats a complete cost and a partial calorie range", () => {
    expect(
      estimateLabel(
        { status: "complete", lower: 3.5, upper: null, coverage },
        "cost",
      ),
    ).toBe("$3.50");
    expect(
      estimateLabel(
        { status: "partial", lower: 120.4, upper: 300, coverage },
        "kcal",
      ),
    ).toBe("120 kcal–300 kcal known · partial");
  });

  it("says Pending for an estimate that has not been computed", () => {
    expect(
      estimateLabel({ status: "pending", reason: "totals_missing" }, "cost"),
    ).toBe("Pending");
  });
});

describe("totalTimeLabel", () => {
  it("prefers the source prose over the minute count", () => {
    expect(totalTimeLabel({ total: "about 1½ hours", totalMinutes: 90 })).toBe(
      "about 1½ hours",
    );
  });
  it("falls back to minutes and is absent with neither", () => {
    expect(totalTimeLabel({ totalMinutes: 135 })).toBe("2 hr 15 min");
    expect(totalTimeLabel({})).toBeNull();
    expect(totalTimeLabel(undefined)).toBeNull();
  });
});

describe("unitPriceLabel", () => {
  it("prints the natural basis with magnitude-aware precision", () => {
    expect(
      unitPriceLabel({
        natural: { price: 0.0030086, unit: "g" },
        perGram: null,
      }),
    ).toBe("$0.00301/g");
    expect(unitPriceLabel({ natural: null, perGram: 0.1 })).toBeNull();
    expect(unitPriceLabel(null)).toBeNull();
  });
});

describe("valuationLabel", () => {
  const counts = (missingPricing: number, miscNoPrice: number) => ({
    missingPricing,
    miscNoPrice,
  });
  it("is absent for an empty or unpriced location", () => {
    expect(
      valuationLabel({ directValuation: 0, direct: counts(0, 0) }),
    ).toBeNull();
    expect(valuationLabel(null)).toBeNull();
  });
  it("carries the pricing caveat beside the total", () => {
    expect(
      valuationLabel({ directValuation: 42.5, direct: counts(2, 1) }),
    ).toBe("$42.50 (no pricing for 2, 1 misc)");
  });
});

describe("expenseCountLabel", () => {
  it("flags unpriced lines beside the count", () => {
    expect(expenseCountLabel(4, 0)).toBe("4");
    expect(expenseCountLabel(4, 2)).toBe("4 · 2 unpriced");
  });
});

describe("reconciliationLabel", () => {
  it("shows the delta only for a mismatch or refund-adjusted verdict", () => {
    expect(
      reconciliationLabel({
        statedTotal: 20,
        expenseTotal: 25,
        reconciliation: "mismatch",
      }),
    ).toBe("Needs review $5.00");
    expect(
      reconciliationLabel({
        statedTotal: 20,
        expenseTotal: 20,
        reconciliation: "match",
      }),
    ).toBe("Reconciles");
    expect(
      reconciliationLabel({
        statedTotal: null,
        expenseTotal: 20,
        reconciliation: "unknown",
      }),
    ).toBe("Nothing to reconcile");
  });
});

describe("settlementLabel", () => {
  it("names the settlement status and its entry count", () => {
    expect(settlementLabel({ status: "match", transactionCount: 2 })).toBe(
      "Settled · 2",
    );
  });
});

describe("mealCostLabel", () => {
  it("reads the meal's cost estimate", () => {
    expect(
      mealCostLabel({
        status: "complete",
        lower: 12,
        upper: null,
        coverage: { covered: 1, total: 1 },
      }),
    ).toBe("$12.00");
  });
});
