import { render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  FinancialSettlementStatus,
  initialSettlementAllocations,
  parseSettlementAllocations,
  financialTransactionCaptureRequestForPurchase,
} from "./financial-settlement";
import { ReconciliationStatus } from "./purchase-reconciliation";

describe("purchase reconciliation statuses", () => {
  it("renders a posted-refund-explained difference neutrally", () => {
    render(
      <ReconciliationStatus
        purchase={{
          statedTotal: 326.36,
          expenseTotal: 199.26,
          unpricedExpenseCount: 0,
          financialReconciliation: { postedRefundTotal: -127.1 },
        }}
      />,
    );

    const label = screen.getByText("Refund-adjusted -$127.10");
    expect(label.parentElement).toHaveClass("inline-flex", "rounded-full");
    expect(label.parentElement).toHaveStyle("--enum-pill-color: var(--slate)");
  });

  it("reserves the warning tone and Needs review label for unexplained gaps", () => {
    render(
      <ReconciliationStatus
        purchase={{
          statedTotal: 326.36,
          expenseTotal: 199.26,
          unpricedExpenseCount: 0,
          financialReconciliation: { postedRefundTotal: 0 },
        }}
      />,
    );

    const label = screen.getByText("Needs review -$127.10");
    expect(label.parentElement).toHaveStyle(
      "--enum-pill-color: var(--warning)",
    );
  });

  it("keeps a matched financial settlement green", () => {
    render(
      <FinancialSettlementStatus
        purchase={fromPartial<
          Parameters<typeof FinancialSettlementStatus>[0]["purchase"]
        >({
          financialReconciliation: {
            status: "match",
            transactionCount: 2,
          },
        })}
      />,
    );

    // "Settled", not the raw `match` enum this status used to interpolate.
    const label = screen.getByText("Settled · 2");
    expect(label.parentElement).toHaveClass("rounded-full");
    expect(label.parentElement).toHaveStyle(
      "--enum-pill-color: var(--positive)",
    );
  });

  it("pre-associates a new settlement transaction with its purchase", () => {
    expect(financialTransactionCaptureRequestForPurchase("PUR-2345")).toEqual(
      expect.objectContaining({
        entity: "financialTransaction",
        operation: "create",
        seed: { purchaseId: "PUR-2345" },
      }),
    );
  });

  it("requires a complete, signed split before saving settlement evidence", () => {
    const transaction = fromPartial<
      Parameters<typeof initialSettlementAllocations>[1]
    >({ amount: 91, kind: "purchase" });
    const purchase = fromPartial<
      Parameters<typeof initialSettlementAllocations>[2]
    >({ statedTotal: 42.5 });
    const rows = initialSettlementAllocations(
      "PUR-2345",
      transaction,
      purchase,
    );
    expect(rows).toEqual([
      { purchaseId: "PUR-2345", amount: "42.50" },
      { purchaseId: "", amount: "48.50" },
    ]);
    expect(parseSettlementAllocations(rows, 91)).toBeNull();
    expect(
      parseSettlementAllocations(
        [
          { ...rows[0]!, amount: "42.50" },
          { purchaseId: "PUR-3456", amount: "48.50" },
        ],
        91,
      ),
    ).toEqual([
      { purchaseId: "PUR-2345", amount: 42.5 },
      { purchaseId: "PUR-3456", amount: 48.5 },
    ]);
    expect(
      parseSettlementAllocations(
        [{ purchaseId: "PUR-2345", amount: "15.00" }],
        -15,
      ),
    ).toBeNull();
  });
});
