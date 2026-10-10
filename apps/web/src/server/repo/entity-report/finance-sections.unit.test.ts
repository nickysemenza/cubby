import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import {
  expenseShortcode,
  financialTransactionShortcode,
  productShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { composeExpenseSettlementSection } from "./expense-settlement";
import { composeFinancialSettlementSection } from "./purchase-financial-settlement";
import { composeReconciliationSection } from "./purchase-reconciliation";

const pur = purchaseShortcode.parse("PUR-2345");
const ftx = (suffix: string) =>
  financialTransactionShortcode.parse(`FTX-${suffix}`);

const purchase = (overrides: Partial<PurchaseOut> = {}) =>
  fromPartial<PurchaseOut>({
    id: pur,
    date: "2026-03-02",
    statedTotal: 100,
    expenseTotal: 50,
    reconciliation: "mismatch",
    financialReconciliation: {
      status: "pending",
      transactionCount: 1,
      postedTransactionCount: 0,
      outstandingTransactionCount: 1,
      postedTotal: 0,
      projectedTotal: 40,
      postedRefundTotal: 0,
      delta: -60,
    },
    ...overrides,
  });

describe("composeReconciliationSection", () => {
  it("states the paperwork, the expenses and the server's verdict with its note", () => {
    const section = composeReconciliationSection(purchase());
    expect(section.rows).toEqual([
      { label: "Stated", value: { type: "money", amount: 100 } },
      { label: "Expenses", value: { type: "money", amount: 50 } },
      {
        label: "Verdict",
        value: {
          type: "pill",
          text: "Needs review -$50.00",
          color: "var(--warning)",
        },
      },
    ]);
    expect(section.notes).toEqual([
      "The expenses don't add up to what the purchase stated, and posted refund evidence doesn't fully explain the difference. Review the expenses, stated total, or settlement evidence.",
    ]);
    expect(section.actions.map((action) => action.id)).toEqual([
      "linkExpenses",
      "linkProducts",
    ]);
  });

  it("reads a missing stated total as nothing to compare, never as spend", () => {
    const section = composeReconciliationSection(
      purchase({ statedTotal: null, reconciliation: "unknown" }),
    );
    expect(section.rows[0]).toEqual({
      label: "Stated",
      value: { type: "money", amount: null },
    });
    expect(section.notes[0]).toMatch(/^No stated total recorded yet/);
  });

  it("keeps a refund-explained gap neutral", () => {
    const section = composeReconciliationSection(
      purchase({
        statedTotal: 326.36,
        expenseTotal: 199.26,
        reconciliation: "refund_adjusted",
      }),
    );
    expect(section.rows[2]).toMatchObject({
      value: {
        type: "pill",
        text: "Refund-adjusted -$127.10",
        color: "var(--slate)",
      },
    });
    expect(section.notes[0]).toMatch(/spend remains the expenses/);
  });
});

const transaction = (
  suffix: string,
  overrides: Partial<FinancialTransactionOut> = {},
) =>
  fromPartial<FinancialTransactionOut>({
    id: ftx(suffix),
    displayName: "Example Hardware",
    accountName: "Example Card",
    status: "posted",
    amount: 91,
    postedDate: "2026-03-04",
    transactionDate: "2026-03-03",
    allocations: [
      { purchaseId: pur, amount: 42.5 },
      { purchaseId: purchaseShortcode.parse("PUR-3456"), amount: 48.5 },
    ],
    ...overrides,
  });

describe("composeFinancialSettlementSection", () => {
  it("shows the slice this purchase received, beside the whole charge", () => {
    const section = composeFinancialSettlementSection(purchase(), [
      transaction("4K7M"),
    ]);
    expect(section.items).toEqual([
      {
        id: ftx("4K7M"),
        title: "Example Hardware",
        lines: ["Example Card · posted · 2026-03-04"],
        amount: 42.5,
        amountNote: "of $91.00",
        badge: null,
        link: { entity: "financialTransaction", id: ftx("4K7M"), label: null },
        disabledReason: null,
      },
    ]);
  });

  it("shows the whole amount when the charge settled only this purchase", () => {
    const section = composeFinancialSettlementSection(purchase(), [
      transaction("4K7M", {
        amount: 40,
        allocations: [{ purchaseId: pur, amount: 40 }],
      }),
    ]);
    expect(section.items?.[0]).toMatchObject({
      amount: 40,
      amountNote: null,
    });
  });

  it("says settlement is evidence, with the posted, projected and delta figures", () => {
    const section = composeFinancialSettlementSection(purchase(), []);
    expect(section.rows).toEqual([
      {
        label: "Status",
        value: { type: "pill", text: "Pending · 1", color: "var(--warning)" },
      },
      { label: "Posted", value: { type: "money", amount: 0 } },
      { label: "Projected", value: { type: "money", amount: 40 } },
      { label: "Delta", value: { type: "money", amount: -60 } },
    ]);
    expect(section.notes).toEqual([
      "Settlement amounts are evidence only. Expense lines remain Cubby's only source of spend.",
    ]);
    expect(section.emptyText).toMatch(/^No linked transactions/);
    expect(section.actions).toEqual([
      {
        id: "matchStatement",
        label: "Match statement activity",
        scope: "section",
        disabledReason: null,
      },
    ]);
  });

  it("omits the delta row when there is no stated total to compare", () => {
    const section = composeFinancialSettlementSection(
      purchase({
        financialReconciliation: {
          status: "unknown",
          transactionCount: 0,
          postedTransactionCount: 0,
          outstandingTransactionCount: 0,
          postedTotal: 0,
          projectedTotal: 0,
          postedRefundTotal: 0,
          delta: null,
        },
      }),
      [],
    );
    expect(section.rows.map((row) => row.label)).toEqual([
      "Status",
      "Posted",
      "Projected",
    ]);
  });
});

const line = (
  suffix: string,
  cost: number | null,
  overrides: Partial<ExpenseOut> = {},
) =>
  fromPartial<ExpenseOut>({
    id: expenseShortcode.parse(`EXP-${suffix}`),
    name: `Line ${suffix}`,
    cost,
    date: "2026-03-02",
    ...overrides,
  });

const context = {
  purchase: {
    id: pur,
    orderId: "ORD-1001",
    displayLabel: null,
    date: "2026-03-02",
    vendorId: vendorShortcode.parse("VEN-4K7M"),
    vendorName: "Example Hardware",
  },
  siblings: [line("5N8P", 20), line("6Q9R", null)],
};

describe("composeExpenseSettlementSection", () => {
  it("totals the whole purchase including this line and names the unpriced", () => {
    const section = composeExpenseSettlementSection(
      line("4K7M", 30, {
        purchaseId: pur,
        productId: productShortcode.parse("PRD-4K7M"),
      }),
      context,
    );
    expect(section.footer).toBe("3 expenses · $50.00 · 1 without a cost");
    expect(section.items?.map((item) => item.id)).toEqual([
      pur,
      "EXP-5N8P",
      "EXP-6Q9R",
    ]);
    expect(section.items?.[0]).toMatchObject({
      title: "ORD-1001",
      badge: "Purchase",
      link: { entity: "purchase", id: pur, label: null },
    });
    expect(section.actions).toEqual([
      {
        id: "splitExpense",
        label: "Split",
        scope: "section",
        disabledReason: null,
      },
      {
        id: "receiveExpense",
        label: "Receive",
        scope: "section",
        disabledReason: null,
      },
    ]);
  });

  it("explains each unavailable verb instead of hiding it", () => {
    const section = composeExpenseSettlementSection(
      line("4K7M", 30, { purchaseId: null, productId: null }),
      null,
    );
    expect(section.items).toEqual([]);
    expect(section.emptyText).toBe(
      "No purchase recorded — this line stands alone until a vendor order claims it.",
    );
    expect(section.footer).toBeNull();
    expect(section.actions.map((a) => [a.id, a.disabledReason])).toEqual([
      [
        "splitExpense",
        "Record this expense's vendor first — a split files its parts under the same purchase.",
      ],
      [
        "receiveExpense",
        "Link a product first — receiving needs something to put on a shelf.",
      ],
    ]);
  });

  it("says when the line is the only one in its purchase", () => {
    const section = composeExpenseSettlementSection(
      line("4K7M", 30, { purchaseId: pur, productId: null }),
      { ...context, siblings: [] },
    );
    expect(section.notes).toEqual([
      "This is the only expense in the purchase.",
    ]);
    expect(section.footer).toBe("1 expense · $30.00");
  });
});
