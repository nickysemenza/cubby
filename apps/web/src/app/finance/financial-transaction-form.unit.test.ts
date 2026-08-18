import { describe, expect, it } from "vitest";
import {
  emptyFinancialTransactionForm,
  financialTransactionFormSchema,
  normalizeFinancialTransactionForm,
} from "./financial-transaction-form";

describe("financial transaction form", () => {
  it("requires a posted date when status is posted", () => {
    const result = financialTransactionFormSchema.safeParse({
      ...emptyFinancialTransactionForm,
      accountId: "FAC-2222",
      amount: 10,
      status: "posted",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["postedDate"] }),
    );
  });

  it("accepts cleared dates for pending transactions", () => {
    const result = financialTransactionFormSchema.safeParse({
      ...emptyFinancialTransactionForm,
      accountId: "FAC-2222",
      amount: 10,
      transactionDate: null,
      postedDate: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(normalizeFinancialTransactionForm(result.data)).toMatchObject({
      transactionDate: null,
      postedDate: null,
    });
  });

  it("rejects a cleared posted date for posted transactions", () => {
    const result = financialTransactionFormSchema.safeParse({
      ...emptyFinancialTransactionForm,
      accountId: "FAC-2222",
      amount: 10,
      status: "posted",
      postedDate: null,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["postedDate"] }),
    );
  });

  it("normalizes nullable text and drops incomplete evidence pairs", () => {
    expect(
      normalizeFinancialTransactionForm({
        ...emptyFinancialTransactionForm,
        accountId: "FAC-2222",
        amount: 10,
        purchaseId: "  ",
        merchant: " Hardware Store ",
        sourceRefs: [
          { source: " statement ", externalId: " tx-1 " },
          { source: "statement", externalId: "" },
        ],
      }),
    ).toMatchObject({
      purchaseId: null,
      merchant: "Hardware Store",
      sourceRefs: [{ source: "statement", externalId: "tx-1" }],
    });
  });
});
