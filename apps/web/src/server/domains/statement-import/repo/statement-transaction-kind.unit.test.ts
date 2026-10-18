import { describe, expect, it } from "vitest";

import { statementTransactionKind } from "./statement-transaction-kind";

describe("statementTransactionKind", () => {
  it.each([
    ["Paychecks", -2500, "income", "rule"],
    ["Interest", 1.25, "interest", "rule"],
    // Interest earned is money in; `interest` means interest charged and must
    // be positive, so an inflow under Interest was once unappliable.
    ["Interest", -8.66, "income", "rule"],
    ["Financial Fees", -35, "refund", "rule"],
    ["Transfer", 500, "account_transfer", "rule"],
    ["Transfer", -500, "account_transfer", "rule"],
    ["Credit Card Payment", 900, "credit_card_payment", "rule"],
    ["Balance Adjustments", 3, "adjustment", "rule"],
    ["Financial Fees", 35, "fee", "rule"],
    ["Groceries", 42.1, "purchase", "rule"],
    ["Payment", -74.38, "credit_card_payment", "rule"],
    ["Credit", -12, "refund", "rule"],
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

  // A card payment under a provider's own "Payment" category was once read as a
  // spending refund and offered for bulk acceptance.
  it("leaves an inflow under an unrecognized category for a label", () => {
    expect(
      statementTransactionKind({ sourceCategory: "Groceries", amount: -12 }),
    ).toEqual({ kind: "refund", kindSource: "sign" });
    expect(
      statementTransactionKind({ sourceCategory: "Other", amount: -74.38 }),
    ).toEqual({ kind: "refund", kindSource: "sign" });
  });

  it("does not call an outgoing paycheck income", () => {
    expect(
      statementTransactionKind({ sourceCategory: "Paychecks", amount: 100 }),
    ).toEqual({ kind: "purchase", kindSource: "sign" });
  });
});
