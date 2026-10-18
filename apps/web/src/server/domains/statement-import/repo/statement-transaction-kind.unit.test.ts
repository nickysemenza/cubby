import { describe, expect, it } from "vitest";

import { statementTransactionKind } from "./statement-transaction-kind";

describe("statementTransactionKind", () => {
  it.each([
    ["Paychecks", -2500, "income", "rule"],
    ["Interest", -1.25, "interest", "rule"],
    ["Transfer", 500, "account_transfer", "rule"],
    ["Transfer", -500, "account_transfer", "rule"],
    ["Credit Card Payment", 900, "credit_card_payment", "rule"],
    ["Balance Adjustments", 3, "adjustment", "rule"],
    ["Financial Fees", 35, "fee", "rule"],
    ["Groceries", 42.1, "purchase", "rule"],
    ["Groceries", -12, "refund", "rule"],
    ["Dividends & Capital Gains", -10, "income", "rule"],
  ] as const)("maps %s at %d to %s", (category, amount, kind, source) => {
    expect(
      statementTransactionKind({ sourceCategory: category, amount }),
    ).toEqual({ kind, kindSource: source });
  });

  it("falls back to the amount's direction when no category speaks", () => {
    expect(
      statementTransactionKind({ sourceCategory: null, amount: 20 }),
    ).toEqual({ kind: "purchase", kindSource: "sign" });
    expect(
      statementTransactionKind({ sourceCategory: null, amount: -20 }),
    ).toEqual({ kind: "refund", kindSource: "sign" });
  });

  it("does not call an outgoing paycheck income", () => {
    expect(
      statementTransactionKind({ sourceCategory: "Paychecks", amount: 100 }),
    ).toEqual({ kind: "purchase", kindSource: "sign" });
  });
});
