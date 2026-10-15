import { describe, expect, it } from "vitest";

import {
  calculateFinancialReconciliation,
  type FinancialReconciliationInput,
  purchaseFinancialMismatchFingerprintRawSql,
  purchaseFinancialMismatchSql,
} from "./financial-reconciliation";

const base: FinancialReconciliationInput = {
  settleableExpenseTotal: 10,
  settleableUnpricedExpenseCount: 0,
  transactionCount: 1,
  postedTransactionCount: 1,
  outstandingTransactionCount: 0,
  postedTotal: 10,
  projectedTotal: 10,
  postedRefundTotal: 0,
};

describe("calculateFinancialReconciliation", () => {
  it.each([
    {
      name: "unknown without settlement evidence",
      input: { ...base, transactionCount: 0 },
      status: "unknown",
      delta: null,
    },
    {
      name: "unknown with an unpriced expense",
      input: { ...base, settleableUnpricedExpenseCount: 1 },
      status: "unknown",
      delta: null,
    },
    {
      name: "pending when projected settlement matches",
      input: {
        ...base,
        settleableExpenseTotal: 51.49,
        transactionCount: 2,
        outstandingTransactionCount: 1,
        postedTotal: 60.56,
        projectedTotal: 51.49,
      },
      status: "pending",
      delta: 0,
    },
    {
      name: "matched when posted settlement matches",
      input: base,
      status: "match",
      delta: 0,
    },
    {
      name: "mismatched against the projected total while outstanding",
      input: {
        ...base,
        outstandingTransactionCount: 1,
        projectedTotal: 12,
      },
      status: "mismatch",
      delta: 2,
    },
    {
      name: "compares in integer cents",
      input: { ...base, settleableExpenseTotal: 10.004, postedTotal: 10.001 },
      status: "match",
      delta: -0.0030000000000001137,
    },
    {
      name: "rounds negative half-cents toward positive infinity like JavaScript",
      input: {
        ...base,
        settleableExpenseTotal: -1.005,
        postedTotal: -1.004,
        projectedTotal: -1.004,
      },
      status: "match",
      delta: 0.0009999999999998899,
    },
    {
      // The shape that motivated `settleableExpenseTotal`: a payment schedule
      // part-way through. Three payments posted, eight still planned. Passing
      // the FULL expense total here reports a mismatch for a purchase that is
      // behaving exactly as intended, so callers must pass the incurred total.
      name: "match when only the incurred portion is compared",
      input: {
        ...base,
        settleableExpenseTotal: 34787,
        transactionCount: 3,
        postedTransactionCount: 3,
        postedTotal: 34787,
        projectedTotal: 34787,
      },
      status: "match",
      delta: 0,
    },
    {
      name: "mismatch if a caller passes the full total including planned spend",
      input: {
        ...base,
        settleableExpenseTotal: 142787,
        transactionCount: 3,
        postedTransactionCount: 3,
        postedTotal: 34787,
        projectedTotal: 34787,
      },
      status: "mismatch",
      delta: -108000,
    },
  ])("returns $status for $name", ({ input, status, delta }) => {
    const result = calculateFinancialReconciliation(input);
    expect(result.status).toBe(status);
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (delta === null) expect(result.delta).toBeNull();
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    else expect(result.delta).toBeCloseTo(delta);
  });
});

describe("settlement mismatch exception predicate", () => {
  it("keys the exception to reconciliation evidence instead of Purchase.updatedAt", () => {
    const predicate = purchaseFinancialMismatchSql('"Purchase"');
    expect(predicate).toContain("to_jsonb");
    expect(predicate).not.toContain('"updatedAt"');
  });

  it("includes the compared settlement total in the evidence fingerprint", () => {
    const fingerprint =
      purchaseFinancialMismatchFingerprintRawSql('"Purchase"');
    expect(fingerprint).toContain('sum(a."amount")');
    expect(fingerprint).toContain("ft.\"status\" IN ('expected', 'pending')");
  });
});
