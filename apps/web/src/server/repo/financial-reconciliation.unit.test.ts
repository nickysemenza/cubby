import { describe, expect, it } from "vitest";
import {
  calculateFinancialReconciliation,
  type FinancialReconciliationInput,
} from "./financial-reconciliation";

const base: FinancialReconciliationInput = {
  expenseTotal: 10,
  unpricedExpenseCount: 0,
  transactionCount: 1,
  postedTransactionCount: 1,
  outstandingTransactionCount: 0,
  postedTotal: 10,
  projectedTotal: 10,
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
      input: { ...base, unpricedExpenseCount: 1 },
      status: "unknown",
      delta: null,
    },
    {
      name: "pending when projected settlement matches",
      input: {
        ...base,
        expenseTotal: 51.49,
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
      input: { ...base, expenseTotal: 10.004, postedTotal: 10.001 },
      status: "match",
      delta: -0.0030000000000001137,
    },
  ])("returns $status for $name", ({ input, status, delta }) => {
    const result = calculateFinancialReconciliation(input);
    expect(result.status).toBe(status);
    if (delta === null) expect(result.delta).toBeNull();
    else expect(result.delta).toBeCloseTo(delta);
  });
});
