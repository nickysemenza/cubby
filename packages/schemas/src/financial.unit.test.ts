import { describe, expect, it } from "vitest";
import {
  financialAccountCreateInput,
  financialAccountUpdateData,
} from "./financial-account";
import {
  financialTransactionCreateInput,
  purchaseSettlementCheckExpression,
} from "./financial-transaction";
import { updateStatementRowsInput } from "./statement-row";

const account = {
  name: "Visa ····4242",
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

  // Pinned deliberately. `drizzle-kit push` does not apply a CHECK definition
  // edit under the same name, so a change here will never reach a live database
  // on its own. This is the tripwire to apply that ALTER deliberately.
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

describe("statement row update contracts", () => {
  const selector = { source: "monarch", externalIds: ["row-1"] };

  it("requires a complete disposition decision", () => {
    expect(
      updateStatementRowsInput.safeParse({
        selector,
        data: { disposition: "ignored" },
      }).success,
    ).toBe(false);
    expect(
      updateStatementRowsInput.safeParse({
        selector,
        data: {
          disposition: "open",
          dispositionReason: "not_modeled",
          dispositionNote: "stale explanation",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts complete ignored and cleared open decisions", () => {
    expect(
      updateStatementRowsInput.safeParse({
        selector,
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Household spending outside Cubby",
        },
      }).success,
    ).toBe(true);
    expect(
      updateStatementRowsInput.safeParse({
        selector,
        data: {
          disposition: "open",
          dispositionReason: null,
          dispositionNote: null,
        },
      }).success,
    ).toBe(true);
  });
});
