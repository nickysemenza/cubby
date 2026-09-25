import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  FinancialSettlementStatus,
  financialTransactionCaptureRequestForPurchase,
  rankSettlementCandidates,
} from "./financial-settlement";
import { purchaseReconciliationOptions } from "./purchase-options";
import { ReconciliationStatus } from "./purchase-reconciliation";

describe("purchase reconciliation statuses", () => {
  it("offers refund-adjusted as a distinct filter cohort", () => {
    expect(purchaseReconciliationOptions).toContainEqual({
      value: "refund_adjusted",
      label: "Refund-adjusted",
      color: "var(--slate)",
    });
  });

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

  it("ranks a late statement charge by amount, date and merchant without suggesting allocated rows", () => {
    const purchase = {
      date: "2026-08-14",
      statedTotal: 42.5,
      vendorName: "ForgeWear",
    };
    const make = (
      id: string,
      fields: Partial<Parameters<typeof rankSettlementCandidates>[1][number]>,
    ) =>
      fromPartial<Parameters<typeof rankSettlementCandidates>[1][number]>({
        id,
        amount: 42.5,
        postedDate: "2026-08-16",
        transactionDate: "2026-08-16",
        merchant: "ForgeWear Online",
        kind: "purchase",
        status: "posted",
        allocations: [],
        ...fields,
      });
    expect(
      rankSettlementCandidates(
        fromPartial<Parameters<typeof rankSettlementCandidates>[0]>(purchase),
        [
          make("FTX-2345", {}),
          make("FTX-3456", { amount: 91 }),
          make("FTX-4567", {
            allocations: [
              {
                purchaseId: parseShortcodeFor("purchase", "PUR-2345"),
                amount: 42.5,
              },
            ],
          }),
          make("FTX-5678", { kind: "account_transfer" }),
        ],
      ).map((candidate) => candidate.transaction.id),
    ).toEqual(["FTX-2345"]);
  });
});
