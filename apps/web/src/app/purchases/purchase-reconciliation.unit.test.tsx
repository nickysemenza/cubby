import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FinancialSettlementBadge } from "./financial-settlement";
import { purchaseReconciliationOptions } from "./purchase-options";
import { ReconciliationBadge } from "./purchase-reconciliation";

describe("purchase reconciliation badges", () => {
  it("offers refund-adjusted as a distinct filter cohort", () => {
    expect(purchaseReconciliationOptions).toContainEqual({
      value: "refund_adjusted",
      label: "Refund-adjusted",
    });
  });

  it("renders a posted-refund-explained difference neutrally", () => {
    render(
      <ReconciliationBadge
        purchase={{
          statedTotal: 326.36,
          expenseTotal: 199.26,
          unpricedExpenseCount: 0,
          financialReconciliation: { postedRefundTotal: -127.1 },
        }}
      />,
    );

    const badge = screen.getByText("Refund-adjusted -$127.10");
    expect(badge.className).toContain("text-slate");
    expect(badge.className).not.toContain("text-warning-ink");
  });

  it("reserves the warning tone and Needs review label for unexplained gaps", () => {
    render(
      <ReconciliationBadge
        purchase={{
          statedTotal: 326.36,
          expenseTotal: 199.26,
          unpricedExpenseCount: 0,
          financialReconciliation: { postedRefundTotal: 0 },
        }}
      />,
    );

    const badge = screen.getByText("Needs review -$127.10");
    expect(badge.className).toContain("text-warning-ink");
  });

  it("keeps a matched financial settlement green", () => {
    render(
      <FinancialSettlementBadge
        purchase={
          {
            financialReconciliation: {
              status: "match",
              transactionCount: 2,
            },
          } as never
        }
      />,
    );

    // "Settled", not the raw `match` enum this badge used to interpolate.
    const badge = screen.getByText("Settled · 2");
    expect(badge.className).toContain("text-positive");
  });
});
