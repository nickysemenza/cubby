import { describe, expect, it } from "vitest";
import {
  cardLastFoursOn,
  currentLast4,
  type FinancialAccountCardNumber,
  type FinancialAccountCardNumberKind,
  financialAccountCreateInput,
  financialAccountUpdateData,
} from "./financial-account";
import {
  financialTransactionCreateInput,
  purchaseSettlementCheckExpression,
} from "./financial-transaction";

const card = (
  last4: string,
  kind: FinancialAccountCardNumberKind = "primary",
) => ({
  last4,
  kind,
  validFrom: null,
  validTo: null,
  note: null,
});

const account = {
  name: "Visa ····3692",
  identity: {
    kind: "credit_card" as const,
    issuer: null,
    network: "visa" as const,
  },
  cardNumbers: [card("3692")],
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
        cardNumbers: [card("692")],
      }).success,
    ).toBe(false);
    // Digits no longer live on the identity — a stale caller must fail loudly.
    expect(
      financialAccountCreateInput.safeParse({
        ...account,
        identity: { ...account.identity, last4: "3692" },
      }).success,
    ).toBe(false);
    expect(
      financialAccountCreateInput.parse({
        name: "Cash",
        identity: { kind: "cash" },
      }),
    ).toMatchObject({ cardNumbers: [] });
    expect(
      financialAccountCreateInput.safeParse({
        name: "Checking",
        identity: {
          kind: "bank_account",
          institution: "Credit union",
          accountType: "checking",
        },
        cardNumbers: [card("1234")],
      }).success,
    ).toBe(true);
  });

  it("keeps card numbers unique, dated in order, with one current primary", () => {
    const parse = (cardNumbers: FinancialAccountCardNumber[]) =>
      financialAccountCreateInput.safeParse({ ...account, cardNumbers })
        .success;
    expect(parse([card("3692"), card("3692", "wallet_token")])).toBe(false);
    expect(parse([card("3692"), card("2002")])).toBe(false);
    expect(
      parse([card("3692"), { ...card("2002"), validTo: "2024-11-30" }]),
    ).toBe(true);
    expect(
      parse([
        { ...card("2002"), validFrom: "2024-12-01", validTo: "2024-11-30" },
      ]),
    ).toBe(false);
    // Not a fresh literal, so the extra key reaches the strict schema.
    const withExtraKey = { ...card("4700", "wallet_token"), extra: 1 };
    expect(parse([withExtraKey])).toBe(false);
  });

  it("derives the current digits and the digits presentable on a date", () => {
    const history = [
      { ...card("1004"), validTo: "2023-04-30" },
      { ...card("2002"), validFrom: "2023-04-01", validTo: "2024-11-30" },
      { ...card("3000"), validFrom: "2024-11-01" },
      card("4700", "wallet_token"),
    ];
    expect(currentLast4(history)).toBe("3000");
    expect(currentLast4([card("4700", "wallet_token")])).toBeNull();
    expect(cardLastFoursOn(history, "2023-11-14")).toEqual(["2002", "4700"]);
    expect(cardLastFoursOn(history, "2023-04-15")).toEqual([
      "1004",
      "2002",
      "4700",
    ]);
    expect(cardLastFoursOn(history, "2026-09-19")).toEqual(["3000", "4700"]);
    // Undated evidence can only be matched by cards that were never bounded.
    expect(cardLastFoursOn(history, null)).toEqual(["4700"]);
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
    expect(
      financialTransactionCreateInput.safeParse({
        ...transaction,
        purchaseId: null,
        kind: "income",
        amount: 152.57,
      }).success,
    ).toBe(true);
  });

  // Pinned deliberately. `drizzle-kit push` does NOT diff CHECK constraints, so
  // a change here will never reach a live database on its own — this test is the
  // tripwire telling whoever changes the sign rules to apply the ALTER by hand.
  it("generates a settlement CHECK matching the TypeScript sign rules", () => {
    expect(
      purchaseSettlementCheckExpression({
        purchaseId: `"purchaseId"`,
        kind: `"kind"`,
        amount: `"amount"`,
      }),
    ).toBe(
      `"purchaseId" IS NULL OR ("kind" IN ('purchase', 'refund', 'adjustment', 'income') AND (("kind" IN ('purchase') AND "amount" > 0) OR ("kind" IN ('refund', 'income') AND "amount" < 0) OR "kind" IN ('adjustment')))`,
    );
  });
});
