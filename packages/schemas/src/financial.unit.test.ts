import { describe, expect, it } from "vitest";
import {
  financialAccountCreateInput,
  financialAccountUpdateData,
} from "./financial-account";
import { financialTransactionCreateInput } from "./financial-transaction";

const account = {
  name: "Visa ····3692",
  identity: {
    kind: "credit_card" as const,
    issuer: null,
    network: "visa" as const,
    last4: "3692",
  },
};

describe("financial account contracts", () => {
  it("accepts representative identity variants and rejects invalid last four", () => {
    expect(financialAccountCreateInput.parse(account)).toMatchObject({
      provisional: false,
      sourceAliases: [],
    });
    expect(
      financialAccountCreateInput.safeParse({
        ...account,
        identity: {
          ...account.identity,
          last4: "692",
        },
      }).success,
    ).toBe(false);
    expect(
      financialAccountCreateInput.safeParse({
        name: "Cash",
        identity: { kind: "cash" },
      }).success,
    ).toBe(true);
    expect(
      financialAccountCreateInput.safeParse({
        name: "Checking",
        identity: {
          kind: "bank_account",
          institution: "Credit union",
          accountType: "checking",
          last4: "1234",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate aliases and does not apply create defaults on updates", () => {
    const alias = {
      source: "monarch",
      alias: "Visa ending 3692",
      externalAccountId: "acct-1",
    };
    expect(
      financialAccountCreateInput.safeParse({
        ...account,
        sourceAliases: [alias, alias],
      }).success,
    ).toBe(false);
    expect(financialAccountUpdateData.parse({})).toEqual({});
  });
});

describe("financial transaction contracts", () => {
  const transaction = {
    accountId: "FAC-2345",
    purchaseId: "PUR-2345",
    kind: "purchase" as const,
    status: "posted" as const,
    amount: 60.56,
    transactionDate: "2026-07-01",
    postedDate: "2026-07-02",
  };

  it("requires a posting date and preserves canonical amount signs", () => {
    expect(financialTransactionCreateInput.parse(transaction).amount).toBe(
      60.56,
    );
    expect(
      financialTransactionCreateInput.parse({
        ...transaction,
        kind: "refund",
        amount: -9.07,
      }).amount,
    ).toBe(-9.07);
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        postedDate: null,
      }).success,
    ).toBe(false);
  });

  it("rejects zero/non-finite amounts and duplicate source references", () => {
    expect(
      financialTransactionCreateInput.safeParse({ ...transaction, amount: 0 })
        .success,
    ).toBe(false);
    const sourceRef = { source: "statement", externalId: "txn-1" };
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        sourceRefs: [sourceRef, sourceRef],
      }).success,
    ).toBe(false);
  });

  it("enforces cent precision and purchase-settlement semantics", () => {
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        amount: 60.561,
      }).success,
    ).toBe(false);
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        kind: "refund",
        amount: 9.07,
      }).success,
    ).toBe(false);
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        kind: "fee",
      }).success,
    ).toBe(false);
  });

  it("accepts income as sale-proceeds settlement, inflow only", () => {
    // A marketplace payout settling a disposal: linked, and an inflow.
    expect(
      financialTransactionCreateInput.parse({
        ...transaction,
        kind: "income",
        amount: -152.57,
      }).amount,
    ).toBe(-152.57);
    // Linked income must be negative — a payout is never an outflow.
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        kind: "income",
        amount: 152.57,
      }).success,
    ).toBe(false);
    // Unlinked income (salary, interest) carries no settlement semantics and
    // keeps an unconstrained sign.
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        purchaseId: null,
        kind: "income",
        amount: 152.57,
      }).success,
    ).toBe(true);
  });
});
