import { financialTransactionSettlementViolation } from "@cubby/schemas/financial-transaction";
import { describe, expect, it } from "vitest";

import {
  decideStatementKind,
  kindAgreed,
  ownAccountNamed,
  statementTransactionKind,
} from "./statement-transaction-kind";

describe("statementTransactionKind", () => {
  it.each([
    ["Paychecks", -2500, "income", "rule"],
    ["Interest", 1.25, "interest", "rule"],
    // Interest earned is money in; `interest` means interest charged and must
    // be positive, so an inflow under Interest was once unappliable.
    ["Interest", -8.66, "income", "rule"],
    ["Financial Fees", -35, "adjustment", "rule"],
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

  it("never proposes a kind the settlement sign rule refuses", () => {
    const categories = [
      "Paychecks",
      "Other Income",
      "Business Income",
      "Income",
      "Dividends & Capital Gains",
      "Interest",
      "Transfer",
      "Transfers",
      "Internal Transfer",
      "Credit Card Payment",
      "Payment",
      "Payments",
      "Credit",
      "Balance Adjustments",
      "Financial Fees",
      "Fees",
      "Groceries",
    ];
    for (const sourceCategory of [...categories, null])
      for (const amount of [12.5, -12.5]) {
        const { kind } = statementTransactionKind({ sourceCategory, amount });
        expect(
          financialTransactionSettlementViolation({
            linked: false,
            kind,
            amount,
          }),
          `${sourceCategory} at ${amount} → ${kind}`,
        ).toBeNull();
      }
  });

  it("does not call an outgoing paycheck income", () => {
    expect(
      statementTransactionKind({ sourceCategory: "Paychecks", amount: 100 }),
    ).toEqual({ kind: "purchase", kindSource: "sign" });
  });
});

const noVotes = { rule: null, label: null, history: null } as const;
const noCounterparty = {
  label: null,
  history: null,
  storedValue: false,
} as const;

describe("decideStatementKind and kindAgreed", () => {
  // A provider category alone once made a friend's payment-app credit a clean
  // `income` suggestion.
  it("never cleans a payment-app credit from a person filed under Paychecks", () => {
    const create = decideStatementKind({
      amount: -40,
      votes: { ...noVotes, rule: "income", label: "income" },
      counterparty: { ...noCounterparty, label: "person" },
      transfer: null,
    });
    expect(create).toMatchObject({ kind: "income", kindSource: "model" });
    expect(kindAgreed(create, null)).toBe(false);
  });

  it("reads an outgoing payment to a person as a purchase, never clean", () => {
    const create = decideStatementKind({
      amount: 25,
      votes: { rule: "purchase", label: "account_transfer", history: null },
      counterparty: { ...noCounterparty, label: "person" },
      transfer: null,
    });
    expect(create).toMatchObject({ kind: "purchase", kindSource: "model" });
    expect(kindAgreed(create, null)).toBe(false);
  });

  it("cleans a kind only when two sources agree and none disagrees", () => {
    const agreed = decideStatementKind({
      amount: 12,
      votes: { ...noVotes, rule: "purchase", label: "purchase" },
      counterparty: { ...noCounterparty, label: "business" },
      transfer: null,
    });
    expect(agreed).toMatchObject({ kind: "purchase", kindSource: "rule" });
    expect(kindAgreed(agreed, null)).toBe(true);

    const alone = decideStatementKind({
      amount: 12,
      votes: { ...noVotes, rule: "purchase" },
      counterparty: { ...noCounterparty, label: "business" },
      transfer: null,
    });
    expect(kindAgreed(alone, null)).toBe(false);

    const disputed = decideStatementKind({
      amount: -12,
      votes: { rule: "income", label: "refund", history: "refund" },
      counterparty: { ...noCounterparty, label: "business" },
      transfer: null,
    });
    expect(disputed).toMatchObject({ kind: "refund", kindSource: "model" });
    expect(kindAgreed(disputed, null)).toBe(false);

    const mixed = decideStatementKind({
      amount: 12,
      votes: { rule: "purchase", label: "purchase", history: "mixed" },
      counterparty: { ...noCounterparty, label: "business" },
      transfer: null,
    });
    expect(kindAgreed(mixed, null)).toBe(false);
  });

  it("lets a label and history settle a kind no category spoke to", () => {
    const create = decideStatementKind({
      amount: -900,
      votes: { rule: null, label: "income", history: "income" },
      counterparty: { ...noCounterparty, label: "business" },
      transfer: null,
    });
    expect(create).toMatchObject({ kind: "income", kindSource: "model" });
    expect(kindAgreed(create, null)).toBe(true);
  });

  // A bank transfer to another member's brokerage and a household checking
  // payment of a member's own card were both bulk-acceptable on agreeing votes
  // alone, skipping the LedgerTransfer a move between owners owes.
  it.each(["account_transfer", "credit_card_payment"] as const)(
    "holds a %s back until its destination account is known",
    (kind) => {
      const create = decideStatementKind({
        amount: 5400,
        votes: { rule: kind, label: kind, history: kind },
        counterparty: { ...noCounterparty, label: "business" },
        transfer: null,
      });
      expect(create).toMatchObject({ kind });
      expect(kindAgreed(create, null)).toBe(false);
    },
  );

  it("holds a stored-value payment back until history names a business", () => {
    // Payment-app payees are people with merchant-like notes ("Burma",
    // "bottega"), which the labeller reads as a business.
    const create = decideStatementKind({
      amount: 67.8,
      votes: { rule: "purchase", label: "purchase", history: null },
      counterparty: { ...noCounterparty, label: "business", storedValue: true },
      transfer: null,
    });
    expect(kindAgreed(create, null)).toBe(false);
    const known = decideStatementKind({
      amount: 67.8,
      votes: { rule: "purchase", label: "purchase", history: "purchase" },
      counterparty: {
        label: "business",
        history: "business",
        storedValue: true,
      },
      transfer: null,
    });
    expect(kindAgreed(known, null)).toBe(true);
  });

  it("holds an unlabelled counterparty back from bulk acceptance", () => {
    const create = decideStatementKind({
      amount: 12,
      votes: { rule: "purchase", label: null, history: "purchase" },
      counterparty: noCounterparty,
      transfer: null,
    });
    expect(kindAgreed(create, null)).toBe(false);
  });

  it("records an own-account move as a transfer whatever the category says", () => {
    const create = decideStatementKind({
      amount: -150,
      votes: {
        rule: "account_transfer",
        label: "account_transfer",
        history: null,
      },
      counterparty: noCounterparty,
      transfer: { accountId: crypto.randomUUID(), ledgerTransfer: false },
    });
    expect(create).toMatchObject({ kind: "account_transfer" });
    expect(
      kindAgreed(create, {
        accountId: crypto.randomUUID(),
        ledgerTransfer: false,
      }),
    ).toBe(true);
    // Between two owners the move is also a LedgerTransfer, a reviewed write.
    expect(
      kindAgreed(create, {
        accountId: crypto.randomUUID(),
        ledgerTransfer: true,
      }),
    ).toBe(false);
  });
});

describe("ownAccountNamed", () => {
  const bank = {
    id: "bank",
    kind: "bank_account" as const,
    names: ["Example Bank"],
    ledgerPartyId: "member-a",
  };
  const wallet = {
    id: "wallet",
    kind: "stored_value" as const,
    names: ["PayFriend"],
    ledgerPartyId: "member-a",
  };
  const otherWallet = { ...wallet, id: "wallet-b", ledgerPartyId: "member-b" };
  const card = {
    id: "card",
    kind: "credit_card" as const,
    names: ["Example Card Co"],
    ledgerPartyId: "member-a",
  };

  it("matches a cash-out on the bank side and the transfer on the wallet side", () => {
    expect(
      ownAccountNamed("PAYFRIEND CASHOUT 8812", bank, [bank, wallet, card]),
    ).toEqual({ accountId: "wallet", ledgerTransfer: false });
    expect(
      ownAccountNamed("Standard transfer to EXAMPLE BANK", wallet, [
        bank,
        wallet,
      ]),
    ).toEqual({ accountId: "bank", ledgerTransfer: false });
  });

  it("ignores a payment through the app to someone else", () => {
    expect(
      ownAccountNamed("PAYFRIEND *SAMPLE PERSON", card, [bank, wallet, card]),
    ).toBeNull();
    expect(
      ownAccountNamed("PAYFRIEND PAYMENT 1234", bank, [bank, wallet]),
    ).toBeNull();
  });

  it("prefers the same owner and flags a move between owners", () => {
    expect(
      ownAccountNamed("PAYFRIEND CASHOUT", bank, [bank, wallet, otherWallet]),
    ).toEqual({ accountId: "wallet", ledgerTransfer: false });
    expect(
      ownAccountNamed("PAYFRIEND CASHOUT", bank, [bank, otherWallet]),
    ).toEqual({ accountId: "wallet-b", ledgerTransfer: true });
    // Several fits under other owners name no account but still owe one.
    expect(
      ownAccountNamed("PAYFRIEND CASHOUT", bank, [
        bank,
        otherWallet,
        { ...otherWallet, id: "wallet-c", ledgerPartyId: "member-c" },
      ]),
    ).toEqual({ accountId: null, ledgerTransfer: true });
  });
});

describe("decideStatementKind sign rules", () => {
  // `interest` and `fee` must be positive: an inflow labelled either became an
  // unappliable suggestion.
  it("never proposes or cleans a kind the transaction's sign refuses", () => {
    const create = decideStatementKind({
      amount: -1.25,
      votes: { rule: null, label: "interest", history: "interest" },
      counterparty: { ...noCounterparty, label: "business" },
      transfer: null,
    });
    expect(create).toMatchObject({ kind: "refund", kindSource: "sign" });
    expect(kindAgreed(create, null)).toBe(false);
  });
});
